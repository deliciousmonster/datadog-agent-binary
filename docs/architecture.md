# Proposed architecture

Ship two binaries, and model the build output as a descriptor list so that a later switch to
bundling is a two-function change rather than a redesign.

Concretely: run `dda inv trace-agent.build` as a second invoke task, copy
`bin/trace-agent/trace-agent` alongside `bin/agent/agent`, publish both inside each platform
package, expose an accessor for each, and ship a shim for each.

## Why two, when one sounds simpler

Three shapes were considered. The comparison is what settles it.

| | **A. Two binaries** | **B. Bundled single binary** | **C. Trace-agent only** |
| --- | --- | --- | --- |
| Build | `agent.build` + `trace-agent.build` | `agent.build --bundle trace-agent` | `trace-agent.build` |
| Windows APM | works | **silently absent** | works |
| Upstream precedent | Datadog's own omnibus packaging does exactly this | no shipping consumer anywhere upstream | n/a |
| Processes at runtime | 2 | **still 2** | 1 |
| Allowlist entries | 2 | 1 | 1 |
| Host metrics and logs | yes | yes | **no** |

Option B is the one that looks cheaper and is not.

Bundling does not save a process. On Linux the code that would start dependent services is two
empty functions; only the Windows counterpart starts a trace-agent service. There is no path by
which `agent run` starts the APM receiver on Linux, so bundling saves disk and nothing else. You
still spawn a second child, still allowlist it, still name it.

Bundling also drops Windows APM silently. Upstream's build task appends bundled agents only on the
non-Windows branch, and the Windows builder sets `GOOS=windows`, so `--bundle trace-agent` is
accepted and discarded with no warning. The Go side agrees: the bundled entry point is gated
behind a `!windows` build constraint. The result would be a Windows package with no APM, produced
on the one CI leg that never executes.

The decisive objection is the failure mode. A binary built without the bundle tag, or invoked with
the wrong `DD_BUNDLED_AGENT`, prints one line to stderr and runs the core agent, exiting zero. A
`trace-agent version` smoke test therefore passes on a binary containing no APM at all, which is
precisely the class of false-green that let the original defect ship 34 times. With two binaries, a
missing trace-agent is a file that does not exist and `test -f` catches it.

Option C works. Measured against the real trace-agent as a non-root user in a slim container, it
answers `/info`, accepts a `v0.4` payload, and reaches Datadog's edge with no core agent on the
box. It is rejected because it gives up host metrics and log forwarding, which the customer has
working today. If those turn out to be out of scope, C is the simpler production shape and worth
reconsidering; that question is open and listed as such.

Two binaries is also what upstream does for its own distribution, so the packaging is the path
Datadog already tests.

One consequence worth stating because it inverts the obvious assumption: the core agent's build
flags must **not** be forwarded to the trace-agent build. It is built with
`--build-exclude=systemd,python --exclude-rtloader --no-enable-bazel`, where the last two skip an
embedded-rtloader install that `--build-exclude` never gated and whose output the excluded `python`
tag then discarded. Neither excluded tag appears in the trace-agent's tag set, and its build task
has no rtloader or embedded-path parameters for the rest to act on, so forwarding any of it would
be wrong rather than merely redundant. Upstream splits it the same way: its AIX packaging passes
`--no-enable-bazel --exclude-rtloader` to `agent.build`, then runs `trace-agent.build` bare.

## One agent per node, not one per worker thread

Harper runs an application across multiple worker threads. A naive supervisor starts a pair of
agents on every thread, and all but one trace-agent then dies on `EADDRINUSE` while the surviving
process is whichever won the race. The design has to produce exactly one core agent and one
trace-agent per node.

Harper already provides the mechanism. It dedupes spawns with an exclusive PID-file lock at
`<rootPath>/pids/<name>.pid`, opened with `wx`, so the first caller wins and every other caller
gets `EEXIST`. The lock lives on the filesystem, so it dedupes across worker threads and across
processes. Two distinct spawn names take two independent locks, which is how one core agent and
one trace-agent coexist while neither is ever started twice.

Two consequences follow, and both have to be handled explicitly rather than discovered later.
The loser of the race does not receive a `ChildProcess`. It gets a handle carrying `pid`,
`kill()`, `unref()` and an `'exit'` event, and nothing else, so any code reaching for `stdout`
without a guard throws on every thread but one. That handle also runs a liveness interval which
is not `unref`'d, so a joining thread never goes idle until it releases it.

## The descriptor model

Rather than a hardcoded pair, each platform describes the binaries it ships: the upstream build
task, the filename upstream produces, the filename we publish, and the accessor name. Building,
packaging, and runtime resolution all iterate that list.

This is what makes the design cheap to change. Adding a third binary is a table entry. Switching
to a bundled build later means changing how the list is produced, not rewriting the build,
packaging and resolution layers that consume it. It also removes a class of bug the current
package demonstrates: when the build copies one hardcoded path and the packaging template
substitutes one hardcoded name, a second binary cannot be added without touching five files that
each assume there is exactly one.

## Version pinning

The upstream Datadog release is pinned in a file at the repository root, read by the build, and
shipped inside the published tarball. `latest` becomes reachable only by asking for it
explicitly.

This closes the defect where a package published as `7.75.5` contained agent `7.79.2`. It also
becomes load-bearing for two binaries specifically: the core agent and the trace-agent share an
IPC auth handshake and a config schema, so a build that resolved each one independently could
produce a pair that does not interoperate. Both come from one ref, and a clone that lands on a
different ref than requested is treated as fatal rather than as something to work around.

## Advantages over the existing component

Each item names the concrete failure it removes. An advantage without a named failure is not
worth listing.

**APM works at all.** The existing component ships no receiver, so every span is dropped. This is
the whole of the customer's reported problem.

**The failure stops being silent.** Today a missing receiver produces no output for the first 30
seconds and one line after 45. The proposed launchers check the trace-agent's two pre-bind failure
conditions before spawning and name the offending path, so a bad config path fails in one line
instead of a 30 second hang. A keyless trace-agent gets its own startup warning, because that is
the most deceptive case: it binds the receiver and accepts spans normally, and only the intake
rejects them, so the tracer sees a successful flush and an empty APM view is the only symptom.

**One agent per node instead of one per worker thread.** Addressed above; the existing component
has no notion of the constraint because it never needed one.

**The shipped version means something.** Pinned upstream ref, verified checkout, and a build that
refuses to proceed when the tree is not the version it claims.

**Platform packages that can install.** npm-valid `os` and `cpu` values, checked before publish
rather than discovered by a consumer who gets no binaries and no error.

**A published package that is verifiable after the fact.** Because `optionalDependencies`
failures are silent and a published version can be deprecated but never replaced, the checks that
matter have to run before the publish and be re-runnable against the registry afterwards.

## What this deliberately does not change

The core agent's behaviour, its configuration surface, and the host metrics and log forwarding the
customer relies on today. The work adds a receiver and the packaging around it.
