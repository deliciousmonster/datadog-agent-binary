# AGENTS.md

What to know before changing this repository. `README.md` is the documentation for people using the
package and explains the same subjects at length; this file is the short version, and where the two
overlap the README is the one to keep current for consumers.

## What the package is

An npm package that ships two pre-compiled Datadog binaries as platform-specific sub-packages, so the
agent installs and versions as an ordinary Node dependency instead of through a system package manager
or a container sidecar. It is built to run alongside a Node application, including inside a Harper v5
component.

| Binary | Role |
| --- | --- |
| `datadog-agent` | Core agent. Metrics, checks, log forwarding, DogStatsD. |
| `trace-agent` | APM receiver. Binds `127.0.0.1:8126` and accepts spans from `dd-trace`. |

## The invariant: the trace-agent is not optional

Earlier releases shipped the core agent alone. Nothing bound 8126, so `dd-trace` connected, got
`ECONNREFUSED`, and dropped every span. Neither side treats that as an error: the core agent parses
the APM config keys it cannot serve and renders an APM status section drawn by shims, and `dd-trace`
classifies a refused connection as a startup race and stays quiet for tens of seconds. Every available
signal points at configuration, which is not what is wrong.

Upstream has no bundling flag. `tasks/agent.py::build()` takes no `bundle` parameter and
`tasks/build_tags.py` lists `trace-agent` as its own target, so the trace-agent exists only if
`trace-agent.build` runs as well. A core agent built from the same commit carries zero receiver
symbols:

```bash
strings -a bin/datadog-agent | grep -c 'datadog-agent/pkg/trace/api\.'   # 0
strings -a bin/trace-agent  | grep -c 'datadog-agent/pkg/trace/api\.'   # > 0
```

A change that makes it possible to build, package, or publish without the trace-agent is wrong. The
descriptor model, the pre-publish matrix gate, and the symbol assertion in `build-verify.yml` all
exist for that single reason.

## The descriptor model

`AgentBinaryDescriptor` (`src/types.ts`) and `Platform.getBinaries()` (`src/platform.ts`) are the one
list. Building, packaging, runtime resolution, and spawning iterate it. Adding a sub-agent should be a
new entry, not an edit to five call sites, and a code path that hardcodes `datadog-agent` or indexes
`getBinaries()[0]` is the original defect coming back.

```
.datadog-agent-version              single pin for the upstream Datadog release
src/types.ts                        AgentBinaryDescriptor
src/platform.ts                     getBinaries(), SUPPORTED_PLATFORMS, the Node os/cpu mapping
src/downloader.ts                   resolves and asserts the pin, clones, verifies git describe
src/builder.ts                      build preconditions, one `dda inv <task>` per descriptor
src/binary-manager.ts               resolves a binary from the platform package at runtime
src/agent-launcher.ts               shared launcher behind bin/datadog-agent and bin/trace-agent
scripts/create-platform-packages.js builds npm/<platform>/ with both binaries and their accessors
scripts/publish-matrix.js           verifies the matrix, staged or published
example/                            a Harper component showing the correct spawn pattern
```

## Constraints that will bite you

Each of these produced a real defect, and none is visible from the code alone.

**Harper's spawn gate does not apply to this package's launchers.** Harper substitutes a constrained
`child_process` only for modules its own loader evaluates. This package is imported natively (its
manifest names no Harper-claimed id, and a guard test keeps it that way), so `spawn(..., { name })`
from a launcher reaches stock Node, which ignores `name`. No PID lock, no allowlist. Component code
that needs the singleton must spawn from its own module graph, reached by a **relative ESM import**
from the component entry file. `example/dd-supervisor.js` does this and self-checks that interception
is live.

**Harper dedupes by PID-file lock**, `openSync(<rootPath>/pids/<name>.pid, 'wx')`. It is
filesystem-based, so it dedupes across worker threads and processes, and two distinct spawn names give
one core agent and one trace-agent per node. Every loser of the race receives an
`ExistingProcessWrapper`: an EventEmitter carrying `pid`, `kill()`, `unref()`, and an `'exit'` event,
and nothing else. Detect it by the absence of `spawnargs`, not by a null `stdout`, since a winner
spawned with `stdio: 'ignore'` also has none. The wrapper polls on a `setInterval` it never unref'd,
so a caller that does not `unref()` it pins the worker's event loop.

**The spawn `version` option must be a number.** Harper reads the recorded value back with `parseInt`
and compares with `!==`, so a string never equals itself and every thread kills and respawns the agent
forever.

**Both spawn paths need allowlisting.** Harper matches `applications.allowedSpawnCommands` as an exact
string compare against `command.split(' ')[0]`, so a bare name, a relative path, or a path containing a
space can never match, and the list is read once at module load. Allowlisting only the core agent
reproduces the original symptom, since metrics and logs keep flowing while the rejected trace-agent
spawn takes every span with it.

**`dd-trace` needs both preload keys.** `threads.preloadRequire: dd-trace/init` is what initializes the
tracer, since `register.js` under `--import` initializes nothing in a worker, and
`threads.preload: dd-trace/register.js` is additionally required or `node:http` is not instrumented.

**`os` and `cpu` must carry Node's values** (`darwin`, `x64`), never this project's internal labels
(`macos`, `x86_64`). npm compares them against `process.platform` and `process.arch`. A mismatch means
the platform package never installs, and because the dependency is optional npm skips it in silence and
`npm ci` still exits 0. `src/platform.ts` derives the mapping in both directions from one table for this
reason; do not hand-write the inverse anywhere else.

**`SUPPORTED_PLATFORMS`, `optionalDependencies`, and the `build-release.yml` matrix must agree.**
`update-optional-deps.js` generates the manifest field from `SUPPORTED_PLATFORMS`, but nothing derives
the CI matrix. A platform declared and never built is silently unresolvable at install time. `npm run
matrix` is the check.

**The Linux legs are pinned to Ubuntu 22.04 for glibc, not for anything else.** Both binaries link
glibc dynamically (the trace-agent's `netcgo` build tag rules out a static build) and glibc only works
upward, so the build runner sets the floor for every host that runs the result. 22.04 ships glibc 2.35,
under the 2.36 of the oldest image these binaries load on; `ubuntu-latest` would emit
`GLIBC_2.38`/`2.39` references that image cannot satisfy. `build-release.yml` checks the floor after
each build, so raising it fails there rather than at a consumer's exec.

**The trace-agent needs an existing `datadog.yaml` and a writable config directory.** A missing file is
an immediate fatal "unable to load Datadog config file"; an unwritable directory is a 30 second hang
followed by an auth-token error. The file only has to exist, and zero bytes is enough. It does not read
the core agent's `/etc/datadog-agent/datadog.yaml`, defaulting instead to
`<installRoot>/etc/datadog.yaml` derived from the binary, which under `node_modules` holds no config.
`preflightTraceAgentConfig()` in `src/agent-launcher.ts` turns both failures into a message before the
process starts.

**The npm version and the bundled agent version are independent.** A package once published as `7.75.5`
contained agent `7.79.2`, and `7.75.5` was not an upstream tag at all. `.datadog-agent-version` is the
single pin, it ships inside the tarball so a consumer can read which agent they got, and
`resolveVersion()` asserts the tag exists before cloning and that `git describe` matches afterwards.
The package version moves on packaging changes and says nothing about what is inside.

## Build preconditions

`src/builder.ts` handles these before anything compiles. They exist because upstream's build assumes a
host that a clean runner is not.

- **Go must match the source's `.go-version`.** A minor mismatch is refused, because Go's runtime and
  crypto defaults move between minors; a patch gap only warns, since upstream floats those. Without the
  check, CI, a laptop, and the source pin drift to three different compilers.
- **dda goes into an isolated environment.** `uv tool install dda` is preferred, pipx is the fallback,
  and `pip install --user` is refused outright rather than attempted: dda resolves its data files under
  the interpreter *prefix* while a user-site install writes them to the *user* scheme, so every command
  dies with a missing `dda-data/uv.lock` after appearing to install fine. pipx builds each venv with
  the interpreter pipx itself was installed under and PATH does not change that, so the builder passes
  `--python <executable>` explicitly, and only once that interpreter satisfies the floor in the source's
  `.python-version`.
- **`XDG_CACHE_HOME` must name an absolute directory under CI.** Upstream's `tools/bazel` wrapper exits
  2 when `CI` is set and it does not, and derives `GOCACHE` and `GOMODCACHE` from it. With `CI` unset the
  same wrapper prints a hint and continues, which is why a laptop build never meets the check and a
  runner dies four minutes into `agent.build`.
- **An empty `dev/` directory under the source root.** `get_build_flags` raises "unable to locate
  embedded path" unless `get_embedded_path` finds one, and that directory otherwise exists only as a side
  effect of the rtloader install the core agent now skips. Empty is what upstream wants: the check is
  `os.path.exists` with no look inside, so no build-tree RPATH is baked into either binary.
  `trace-agent.build` needs it too and has no `--embedded-path` parameter, which is why it is created
  once for the whole descriptor loop rather than passed as a core-agent flag.
- **`--exclude-rtloader --no-enable-bazel` on the core agent, and nothing on the trace-agent.**
  `--build-exclude=python` strips a Go build tag and nothing else; `tasks/agent.py` gates the
  embedded-rtloader install on a separate parameter, so the build kept doing expensive work whose output
  the excluded tag then discarded. Under the default `enable_bazel=True` that install extracts an LLVM
  toolchain the Linux path never invokes, filling a 14 GB runner before a Go file compiled. The
  trace-agent's `build()` has no rtloader parameter at all, so forwarding any of this to it would be
  wrong rather than merely redundant.
- **Windows needs its host assumptions corrected before bazel starts.** `.bazelrc` pins `BAZEL_SH` and
  `--shell_executable` at `C:/tools/msys64/usr/bin/bash.exe`, which the GitHub Windows image does not
  have; the builder writes a `user.bazelrc` (gitignored upstream, and already `try-import`ed by
  `.bazelrc`, so the source tree stays clean for `git describe`) pointing both at the real MSYS2. And
  `tools/bazel.bat` exits 2 when `%TEMP%` sits on a volume where NTFS 8.3 short-name creation is off,
  which is every non-system volume by default, so `TEMP` is relocated to the user profile's own Temp on
  the system volume. `DD_GO_PDB=0` on the same leg keeps upstream's `-Wl,--pdb=` from reaching the host
  linker for a PDB this package does not ship.

Override either binary's flags with `DD_AGENT_BUILD_ARGS` or `DD_TRACE_AGENT_BUILD_ARGS`. Args are split
on spaces and spawned without a shell, so an override must be plain space-separated tokens.

## Testing

`npm test` is `node --test "test/**/*.test.js"` and must stay hermetic, meaning no network and no agent
binary. Anything needing a real binary or a real Harper belongs in `test/integration/` and must
**skip with a reason** rather than fail when its prerequisites are absent, so a fresh checkout that has
never run a release build still goes green. CI separately asserts the test glob matched something,
because `node --test` exits 0 when it matches nothing.

Prefer negative assertions. "Spawn without a name throws" proves the runtime enforces the rule; "spawn
with a name works" also passes on a runtime with no enforcement at all.

**`npm ci --omit=peer` if you are not running the integration suite.** `@harperfast/integration-testing`
names `harper` as a required peer, and npm installs it: 901 of the 984 packages in the tree, 610 MB of
the 688 MB, and 10 s of the 12 s a warm `npm ci` takes. Omitting peers leaves 83 packages and 78 MB, and
`typecheck`, `typecheck:test`, `test`, `lint`, and `format:check` all still pass. `test:integration`
then skips every case with the reason rather than failing, which is the same behaviour a contributor on
an unsupported platform already gets. Run a plain `npm ci` before touching anything under
`test/integration/`.

Twelve of the thirteen advisories `npm audit` reports sit in that peer tree; the thirteenth is
`picomatch@2.3.1`, reached through `@harperfast/code-guidelines` and its `typescript-eslint`, which this
repository installs for a five-line prettier config and never lints with. None of it reaches a consumer:
the published package declares no `dependencies` at all.

## Conventions

- Tabs, single quotes, 120 columns, semicolons, from `@harperfast/code-guidelines/prettier` via
  `prettier.config.mjs`. lint-staged runs `prettier --check` on commit, so a badly formatted file fails
  the commit instead of being reformatted underneath you. oxlint is the linter.
- ESM-only (`"type": "module"`, NodeNext emit), and imports carry `.js` extensions. `require()` of the
  built entry still works on the supported engines and a guard test pins that, so no top-level await in
  anything reachable from `src/index.ts`. The generated platform packages stay CommonJS deliberately.
- `@types/node` tracks the 22 line on purpose. It has to match the `engines` floor, or code calling an
  API absent from Node 22.18 compiles clean and breaks for a consumer on the version the package
  advertises.
- Do not rename exports or change signatures without checking `scripts/` and `test/`. Several read them
  by name.
- Comments explain why, never what. The bar: would a competent engineer be surprised, or make the wrong
  change, without this? Keep the choices where the obvious approach is the wrong one, and the
  silent-failure warnings. Cut restatements of the code and doc comments that repeat the function name.

## Commands

```bash
npm run build              # tsc
npm run typecheck          # tsc --noEmit
npm run typecheck:test     # the integration suite's tsconfig, which the root one excludes
npm test                   # unit + e2e, hermetic
npm run test:integration   # boots a real Harper (needs Node >=22.18)
npm run lint               # oxlint
npm run format:check       # prettier
npm run matrix             # what is published per platform, and whether it is correct
npm run matrix:local       # the same, against staged npm/ directories
npm run build-agent        # both binaries for this platform (needs Go, Python, dda)
```

## CI

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `test.yml` | every push, every PR | lint, typecheck, hermetic tests on 6 legs; real-Harper integration on ubuntu |
| `prerelease.yml` | push to `main`, manual | computes and pushes the next `-next.N` tag |
| `build-release.yml` | `v*` tags, manual | build, gate, publish, verify |
| `build-verify.yml` | nightly, manual | builds both binaries and proves the receiver works, without publishing |
| `matrix-drift.yml` | weekly | registry versus declared |
| `validate-caller-workflows.yml` | every PR, push to `main` | checks any `claude-*` / `gemini-*` caller workflows for shadow jobs and unpinned refs |
| `check-upstream.yml` | disabled | do not re-enable without making it write `.datadog-agent-version` |

`build-verify.yml` has no push trigger by design, since a release run already builds all four platforms
and asserts the receiver. The nightly covers what nothing else does: the upstream pin and the Datadog
build tasks can break with no commit of ours.

The pre-publish matrix gate runs **before** `npm publish`, because that is the last moment anything can
change. A published version can be deprecated but never replaced. Platform packages publish before the
main package, or its `optionalDependencies` point at nothing for a window.

## Branches and releases

`main` is the default branch and the release branch; `dev` is where work integrates. A change branches
off `dev`, opens a pull request into `dev`, and reaches `main` in a later pull request from `dev`.
`main` being the repository default means `gh pr create` aims there unless you pass `--base dev`, so
pass it every time.

A merge to `main` does not publish. A `v*` tag is the only input to the publish pipeline: it sets the
npm version, and whether it parses as a semver prerelease decides the dist-tag. A tag with a prerelease
segment publishes under `next`; a tag without one takes over `latest` for every consumer installing
without a tag. **Cut Prerelease** exists so nobody hand-types that tag. It waits for the commit's `Test`
run to go green, asks both the registry and the git tags which `-next.N` numbers are taken, and pushes
the next one, gated on a `RELEASE_ENABLED` variable and a `REPO_TOKEN` PAT because a tag pushed with
`GITHUB_TOKEN` starts no workflow.

One npm behaviour has no workaround and bites exactly once per name: on a package's very first publish,
npm sets `latest` regardless of `--tag`, because a package with no dist-tags needs one. A new name whose
first release is a prerelease becomes the default install. The publish job asserts afterwards that
`latest` is not the prerelease and fails if it is.

Publishing is idempotent, so a tag that failed partway can be re-run. `npm publish --provenance`
requires a public `repository` field matching the repository the publish runs from;
`release-preflight.js` compares the slug and not the repository's visibility, so a private repository
clears preflight and fails at publish, after every platform's Go build.
