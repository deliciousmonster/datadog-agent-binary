# Discovery

Server-side APM traces never left the Harper runtime because nothing was listening for them.
`@harperfast/datadog-agent-binary` compiles and ships the Datadog **core agent** only. The
**trace-agent**, which is the process that owns the APM receiver on `127.0.0.1:8126`, is never
built, never copied, never packaged, never resolvable, and never spawned. `dd-trace` in the
application emits spans, gets `ECONNREFUSED`, and drops them.

This is a missing process, not a misconfiguration. No amount of application-level configuration
could have fixed it, which is why the configuration work already attempted did not move the
result.

## The artifact proof

The published tarball was pulled from the registry and inspected directly, so this does not rest
on reading source.

```
$ npm pack @harperfast/datadog-agent-binary-linux-x86_64@7.75.5
$ tar -tzvf harperfast-datadog-agent-binary-linux-x86_64-7.75.5.tgz
-rwxr-xr-x  151952712  package/bin/datadog-agent
-rw-r--r--        133  package/index.js
-rw-r--r--        487  package/package.json
```

One binary. The ELF is not stripped, which is what makes a symbol count proof rather than
inference. Running `strings` against that 152 MB file:

| Probe | Occurrences |
| --- | --- |
| `DataDog/datadog-agent/cmd/trace-agent` | **0** |
| `DataDog/datadog-agent/pkg/trace/api` (the receiver package) | **0** |
| `/v0.4/traces` (the endpoint the tracer posts to) | **0** |
| `DataDog/datadog-agent/pkg/aggregator` (control, proving extraction works) | **809** |

The control matters. A probe returning zero is only evidence if a probe against something that
should be present returns a large number.

The reproduction takes about thirty seconds and needs no access to the customer's environment:

```bash
curl -sSL -o dd.tgz \
  'https://registry.npmjs.org/@harperfast/datadog-agent-binary-linux-x86_64/-/datadog-agent-binary-linux-x86_64-7.75.5.tgz'
tar -xzf dd.tgz
tar -tzf dd.tgz | grep bin/                                       # one binary
strings -a package/bin/datadog-agent | grep -c 'pkg/trace/api\.'  # 0 - no receiver
```

## Six links, each independently sufficient

The trace-agent is absent at every layer of the package, and any one of these alone would break
APM. All six are present.

| # | Link | Where |
| --- | --- | --- |
| 1 | **Never built.** The build runs exactly two invoke tasks, `install-tools` and `agent.build`. There is no `trace-agent.build`. | `src/builders/base.ts:15-27` |
| 2 | **Never copied.** The copy step moves exactly one file and hardcodes the source subdirectory `bin/agent`. Upstream writes the trace-agent to `bin/trace-agent/trace-agent`, so even renaming the target would look in the wrong place. | `src/builders/base.ts:269-298` |
| 3 | **Never modeled.** The platform abstraction returns a single binary name. | `src/platform.ts:53` |
| 4 | **Never packaged.** The generated platform package exposes one accessor, and the template is structurally single-binary: the substitution replaces only the first occurrence of the placeholder. | `scripts/create-platform-packages.js:33-53`, `:104-110` |
| 5 | **Never resolvable.** Binary resolution returns one path and reads only `getBinaryPath`. | `src/binary-manager.ts:24-62` |
| 6 | **Never spawned.** The shim spawns exactly one child. | `bin/datadog-agent:45-61` |

A repo-wide grep for `trace`, `8126`, and `apm` across every `.ts`, `.js`, `.yml`, `.json` and
`.md` file returns **0 matches**. The trace-agent is not omitted by a broken code path. It is
absent from the design.

## Where it went

The trace-agent was in the copy list at the start of the project. A single commit on 2025-06-24
replaced a loop over four binaries, `trace-agent` among them, with one hardcoded copy of the core
agent. The commit message states the intent plainly: only copy the agent binary for now, since
that is all we are building at the moment.

That was eight days before the first release. Thirty-four consecutive releases over eleven months
followed, each shipping the core agent alone. A deliberately temporary narrowing became permanent
because nothing downstream could notice it had happened.

## Why it read as a configuration problem

The core agent parses the APM configuration keys it cannot serve. `DD_APM_RECEIVER_PORT` and
`apm_config.receiver_port` each appear in the binary; the receiver package appears zero times.
Setting `DD_APM_ENABLED=true` or pointing `DD_APM_RECEIVER_PORT` at 8126 is accepted without
complaint and does nothing.

`datadog-agent status` compounds it by rendering an APM section. The only trace-related symbols
linked into the core agent are logging, utility and status-reporting shims, which exist so the
status command can draw that section. They contain no receiver.

An operator therefore sees configuration that is accepted, a status page with an APM heading, and
no traces. Every signal available points at configuration, and configuration was never the
problem.

## Why the failure was silent

Measured against dd-trace 6.10.0 on Node v24.16.0, `ECONNREFUSED` is classified retriable, with a
30 second startup grace window, five attempts, and backoff timers that are `unref`'d.

- A process alive **6 seconds** after the first flush prints nothing at all. No warning, no
  error, no diagnostic.
- A process alive **45 seconds** prints exactly one line:
  `DATADOG TRACER DIAGNOSTIC - Agent Error: connect ECONNREFUSED 127.0.0.1:8126`.
- The `Error sending payload to the agent` line sits behind a diagnostics channel with no
  subscribers unless `DD_TRACE_DEBUG=true`.

The application never crashes, never blocks, and reports nothing. Short-lived work finishes before
the one diagnostic line is due, so the most common case produces total silence.

## Why CI did not catch it

Five checks run against this package, and none of them can observe a missing receiver.

| Check | What it actually does | Catches it? |
| --- | --- | --- |
| Release smoke test | Runs `datadog-agent version` with the build tree hidden. Unix only. | No. `version` prints and exits; it binds nothing. |
| glibc floor check | `readelf` against one hardcoded path. | No. |
| Platform-package e2e | Runs the generator in `--dummy` mode, which skips binary copying entirely, and asserts metadata. | No. It cannot see binaries. |
| Harper component e2e | Fabricates a stub binary that is a Node script echoing a marker, and models Harper's enforcement with nine hand-written lines. | No. |
| `harper-integration.sh` | The only script that boots real Harper. | No, twice over. |

That last row is worth being precise about. The script is referenced by no workflow and no npm
script, so it never runs. If it did run it would install `harperdb` v4.7.36, which has no
`applications` block and no `allowedSpawnCommands` at all, so it would pass against a runtime with
zero enforcement and prove nothing about v5.

## Two defects found alongside the root cause

**The shipped version is fiction in both directions.** The package published as `7.75.5` contains
Datadog Agent `7.79.2`. Nothing in the build pins the upstream release, so an artifact carries
whatever upstream had tagged on the day it was built. This becomes blocking for two-binary work:
the core agent and the trace-agent share an IPC auth handshake and a config schema, so both must
come from one upstream ref or they will not talk to each other.

**One platform package can never install.** `macos-x86_64` was published with `os: ["macos"]` and
`cpu: ["x86_64"]`, which is this project's own vocabulary. npm compares those fields against
`process.platform` and `process.arch`, which produce `darwin` and `x64`. The package therefore
matches no machine. Because it is declared as an `optionalDependency`, npm skips it without an
error and the install exits zero.

The other four platform packages are correct and do install. An early reading of
`package-lock.json` suggested all five were broken; querying the live registry corrected it. A
lockfile records what one machine resolved on one day and is not a statement about the registry.

## Scope this sets

The core agent is running in the customer's environment, so host metrics and log forwarding work
today. The gap is APM only, which matches the original brief and bounds what has to change.
