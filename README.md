# Datadog Agent Binary

[![Datadog Agent Binaries](https://github.com/deliciousmonster/datadog-agent-binary/actions/workflows/build-release.yml/badge.svg)](https://github.com/deliciousmonster/datadog-agent-binary/actions/workflows/build-release.yml)

Distributes the pre-compiled [Datadog Agent](https://github.com/DataDog/datadog-agent) as an npm package, so the agent is installed and versioned as a normal Node dependency instead of through a system package manager or a container sidecar. Intended for running the agent alongside a Node application, including inside Harper v5.

**Two binaries ship, because upstream builds two and offers no flag to fold one into the other.**

| Binary | What it is | Command | Accessor | Harper spawn `name` |
| --- | --- | --- | --- | --- |
| `datadog-agent` | Core agent: host metrics, checks, log forwarding, DogStatsD. | `datadog-agent` | `getBinaryPath()` | `datadog-agent` |
| `trace-agent` | APM receiver. Binds `127.0.0.1:8126` and accepts spans from `dd-trace`. | `datadog-trace-agent` | `getTraceAgentBinaryPath()` | `datadog-trace-agent` |

**If traces never show up in Datadog, the trace-agent is the answer.** `dd-trace` posts spans to `127.0.0.1:8126` and treats a failed flush as nothing worth reporting. With no process on that port the tracer still creates spans, still flushes on schedule, and drops every one: the application logs nothing and exits normally. Releases before the trace-agent was added shipped the core agent alone, which produces exactly that symptom. See [Troubleshooting](#troubleshooting-no-traces-in-datadog).

Both files live in the same platform package as `bin/datadog-agent` and `bin/trace-agent` (`.exe` on Windows), exposed as npm `bin` entries.

The package is **ESM-only** (`"type": "module"`) and requires Node `^22.18.0 || >=24.0.0`. `require()` of the built entry point still works across that range, since its module graph is synchronous; a unit test asserts it on every run.

## What it does

- Installs both binaries for the current platform through `optionalDependencies`. No install scripts, no download at install time.
- Provides `datadog-agent` and `datadog-trace-agent` commands that resolve their binary and run it, passing arguments and environment through unchanged.
- Logs binary resolution, the spawn (path, args, PID), exit status, and which Datadog env vars are present. `DD_API_KEY` is reported as `set`/`MISSING`, never by value.
- Checks the trace-agent's two pre-bind failure conditions before spawning it, so a bad config path fails in one line instead of a 30 second hang.
- Builds both binaries from Datadog source for Linux, Windows, and macOS.

It does not configure Datadog. API key, site, and collection settings are supplied the usual way, through environment variables or `datadog.yaml`.

## Installation

```bash
npm install @deliciousmonster/datadog-agent-binary
```

The main package is platform-agnostic and declares one `optionalDependency` per platform, each tagged with npm `os`/`cpu`, so `npm install` fetches only the one matching your machine.

> **Bootstrap: the `@deliciousmonster` platform packages are not published yet.** Because the dependencies are *optional*, npm skips them silently and `npm ci` still exits 0; `node_modules/@deliciousmonster/` is never created and there is no install-time warning. The first symptom is at runtime, where `BinaryManager` finds no packaged binary and falls through to the build-from-source path. Publish the platform packages first (the release workflow already orders it that way), then regenerate `package-lock.json` so the lock carries real integrity hashes instead of the `{ "optional": true }` placeholders npm records for an unresolvable package.

## Observability coverage

| Pillar | Status | What you get, and what you don't |
| --- | --- | --- |
| Metrics | Needs check configuration | DogStatsD works as soon as the core agent runs with an API key, but a host check runs only if `conf.d` names it: the checks are compiled into the binary and the collector schedules nothing else. Configurations ship in [`conf.d/`](conf.d) and the [example component](example/) writes them into its runtime tree. See [Host metrics](#host-metrics). **No Python integrations**: the build excludes the `python` tag, so `postgres`, `redis`, `nginx`, and the rest of `datadog_checks.*` are absent. |
| Logs | Supported, off by default | `DD_LOGS_ENABLED` defaults to `false`, and turning it on is not sufficient: the Agent also needs a `conf.d` file source. See [Log collection](#log-collection-harper-hdblog). |
| Traces | Via the trace-agent | Needs `dd-trace` loaded in the application *and* the trace-agent running. Either alone produces no traces and no error. |

The `python` exclusion is forced. Linking the embedded CPython gives a binary that resolves librtloader through an rpath into the build tree, so it runs only on the machine that built it. A relocatable npm artifact and Python integrations are mutually exclusive under this build.

## Usage

```bash
# Core agent: metrics, checks, log forwarding, DogStatsD. -c takes a DIRECTORY.
datadog-agent run -c /path/to/datadog-config-dir
datadog-agent status

# Trace-agent: APM receiver on 127.0.0.1:8126. -c takes the FILE.
datadog-trace-agent run -c /path/to/datadog.yaml
```

Arguments and environment pass straight through, so any subcommand either agent supports works. They are independent processes and neither starts the other: `datadog-agent run` alone gives metrics and logs with no APM; `datadog-trace-agent run` alone gives APM with no host metrics. Most deployments want both.

**Always pass the trace-agent a `-c`.** Its default is not the core agent's `/etc/datadog-agent/datadog.yaml` but `<install path>/etc/datadog.yaml`, derived from where the executable sits — for a binary npm unpacked into `node_modules`, somewhere with no `datadog.yaml`. Two requirements its own failure output does not name:

- **The file must exist.** Contents are irrelevant to startup; a 0-byte file is enough. Without it the process exits immediately with `unable to load Datadog config file`.
- **Its directory must be writable by the running user**, because the agent writes its `auth_token` there. Without write access it hangs 30 seconds and dies with `error while creating or fetching auth token`.

The `datadog-trace-agent` wrapper checks both before spawning and names the offending path; with an explicit `-c` a failure is fatal, with an inferred path it only warns. For `run` it also asks `/info` whether a receiver is already up and exits 0 if so — `/info` rather than a TCP probe, because a bare probe reports success whenever anything holds the port, which is indistinguishable from the bug this package exists to fix.

### Connecting to Datadog

| Variable | Purpose | Notes |
| --- | --- | --- |
| `DD_API_KEY` | Authenticates to Datadog | Without it the agent starts but **disables** its connection. Nothing is sent. |
| `DD_SITE` | Destination site | `datadoghq.com` (default), `datadoghq.eu`, … |
| `DD_ENV` | `env` tag on all data | e.g. `production`. |
| `DD_LOGS_ENABLED` | Log collection on/off | Defaults to `false`. |
| `DD_APM_ENABLED` | APM receiver on/off in the trace-agent | Defaults to `true`. |
| `DD_APM_RECEIVER_PORT` | Port the trace-agent binds | Defaults to `8126`. |
| `DD_TRACE_AGENT_URL` | Where `dd-trace` sends spans | Read by the tracer, not the agent. Defaults to `http://127.0.0.1:8126`. |

`DD_APM_RECEIVER_PORT` and `DD_TRACE_AGENT_URL` have to agree. A mismatch drops every span with no error on either side: the tracer gets a connection failure it does not surface, and the receiver never sees a request.

A keyless trace-agent gets its own startup warning, because it is the most deceptive case: it binds the receiver and accepts spans normally, and only the intake rejects them, so the tracer sees a successful flush and an empty APM view is the only symptom.

Full list: [Agent environment variables](https://docs.datadoghq.com/agent/guide/environment-variables/).

### Host metrics

An agent whose `conf.d` names no check collects nothing about the host, and says so nowhere useful. `datadog.agent.running` still arrives on every flush, because the aggregator appends it rather than collecting it, so the forwarder reports `202 Accepted` for a payload with no `system.*` series in it. In the Datadog UI that reads as a working pipeline and a host with no metrics.

Configurations for the host checks ship under [`conf.d/`](conf.d), one `<check>.d/conf.yaml.default` per check:

| Check | Metrics | Platforms |
| --- | --- | --- |
| `cpu` | `system.cpu.*` | all |
| `memory` | `system.mem.*`, `system.swap.*` | all |
| `uptime` | `system.uptime` | all |
| `load` | `system.load.*` | not Windows, which has no load average |
| `io` | `system.io.*` | all |
| `disk` | `system.disk.*`, `system.fs.inodes.*` | all |
| `file_handle` | `system.fs.file_handles.*` | all |
| `network` | `system.net.*` | Linux and Windows; the check has no macOS implementation |

Point `confd_path`/`DD_CONFD_PATH` at that directory and the Agent reads them as they are: `.default` is the extension its file provider treats as a check to run by default, and it is superseded by a plain `conf.yaml` for the same check in the same directory, which is where your own settings go.

`ntp` is deliberately absent. Upstream enables it, but it reaches a public NTP pool over UDP every fifteen minutes and reports `CRITICAL` when that egress is blocked, which is the normal case in a container, about a clock the container cannot set anyway. Add `ntp.d/conf.yaml` with `instances: [{}]` if you want it.

### Log collection (Harper `hdb.log`)

A template ships at [`conf.d/harperdb.d/conf.yaml.example`](conf.d/harperdb.d/conf.yaml.example). Copy it into the Agent's `conf.d` (or point `confd_path`/`DD_CONFD_PATH` at it).

**`hdb.log` is multi-line plain text, so the `multi_line` rule is mandatory.** An event starts with an ISO-8601 timestamp and its stack frames continue on lines that do not. By default the Agent treats every physical line as its own log, which is the "logs coming in line by line" symptom.

```yaml
logs:
  - type: file
    path: "/path/to/harper/log/hdb.log" # {ROOTPATH}/log/hdb.log
    service: "harper" # match DD_SERVICE
    log_processing_rules:
      - type: multi_line
        name: harper_new_log_starts_with_timestamp
        pattern: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}' # auto-anchored; no leading ^
```

Measured against a real `hdb.log`: 185,440 physical lines collapse to 15,952 events.

### Programmatic usage

```typescript
import { BinaryManager } from "@deliciousmonster/datadog-agent-binary";

const manager = new BinaryManager();
const corePath = await manager.ensureBinary(); // core agent
const tracePath = await manager.ensureTraceAgentBinary(); // trace-agent
```

`ensureBinary(kind?)` takes the binary kind, so `ensureBinary("trace")` and `ensureTraceAgentBinary()` are the same call. No arguments resolves the core agent.

Each resolves through the platform package's accessor, falling back to a locally built binary. A platform package published before the trace-agent existed has no `getTraceAgentBinaryPath()`; `ensureTraceAgentBinary()` says so by name rather than failing generically.

## Supported platforms

| OS | Architecture | Status |
| --- | --- | --- |
| Linux | x86_64 | Supported |
| Linux | arm64 | Supported |
| macOS | arm64 | Supported |
| Windows | x86_64 | Supported |
| macOS | x86_64 | Not supported: GitHub retired the `macos-13` Intel runner |
| Windows | arm64 | Not supported: [Chocolatey](https://chocolatey.org) has no native arm64 |

This set must match `SUPPORTED_PLATFORMS` in `src/platform.ts` and the build matrix in `.github/workflows/build-release.yml`. A platform listed in `SUPPORTED_PLATFORMS` becomes an `optionalDependency`, so if no matrix leg builds it, npm skips the missing package at install time **without an error**. `npm run matrix` checks this.

Restoring macOS x86_64 needs a build leg (self-hosted Intel, or a verified darwin/amd64 cross-compile with CGO on, which the `netcgo` build tag requires) added in the same change as the `SUPPORTED_PLATFORMS` entry.

## Harper v5 (Lincoln)

A complete runnable component — config, supervisor, verification steps, non-root paths — is in **[`example/`](example/README.md)**. It is in the repository only, not the npm tarball. Two things to know before reading it:

**Allowlist both paths.** Harper only lets a component `spawn` an executable that is launched with a `name` option and listed by exact absolute path in `applications.allowedSpawnCommands`. Allowlisting only the core agent reproduces the original symptom: metrics and logs flow, the trace-agent spawn is rejected, traces vanish, nothing looks broken.

```yaml
applications:
  allowedSpawnCommands:
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

The match is an exact string compare on `command.split(' ')[0]`, so a bare name, a relative path, or any path containing a space can never match. The list is read once at module load, so Harper needs a restart after editing it. The paths carry no version number and survive a package upgrade.

That block goes in the node's `harper-config.yaml`, which on an installed node is the absolute path `settings_path` names in `~/.harperdb/hdb_boot_properties.file`. Harper parses one config file and never merges two, so a hand-created `harperdb-config.yaml` beside it is silently unread and the allowlist appears to have been ignored.

**The shipped launchers do not give you the one-agent-per-node singleton.** Harper dedupes spawns with an exclusive PID-file lock on `<rootPath>/pids/<name>.pid`, and two distinct names take two independent locks — which is how one core agent and one trace-agent coexist while neither starts twice. But that only applies to modules Harper's own loader evaluates, and it never evaluates this package: for a bare specifier under `node_modules`, `shouldUseApplicationLoader` defers to `packageDependsOnHarper`, and this manifest names no Harper-claimed id. On that native path `createModule` hands the URL to Node's own `import()` and wraps the result as a `SyntheticModule`, which has no linker, so the loader never sees this package's internal imports either. Measured against Harper 5.2.1 (`dist/security/jsLoader.js:499-517` and `:656`).

So `spawn` inside these launchers is stock Node: it ignores `name`, takes no lock, and consults no allowlist. To get the singleton, the spawn must live in **your component's own module graph**, reached by a relative ESM import from your entry file — which is what [`example/dd-supervisor.js`](example/dd-supervisor.js) does, including a startup self-check that proves interception is live and fails loudly otherwise.

Harper installs packages with `--ignore-scripts` by default. This package uses no install scripts, so `applications.allowInstallScripts` is not needed. `DatadogAgentBuilder` shells out to `dda` and `go`; it is for a developer shell or a CI runner, never inside a Harper-managed process.

## Troubleshooting: no traces in Datadog

Spans are dropped quietly at every stage. Work down in order; the first failing check is the answer.

| Check | How | If it fails |
| --- | --- | --- |
| Is the trace-agent running? | `pgrep -fl trace-agent` | Nothing is receiving spans. Start `datadog-trace-agent run -c <config>` and read the launcher output for a preflight failure or a rejected spawn. |
| Is the receiver answering? | `curl -s http://127.0.0.1:8126/info` | Compare `DD_APM_RECEIVER_PORT` against the tracer's `DD_TRACE_AGENT_URL`, and confirm `DD_APM_ENABLED` is not `false`. A healthy response lists `/v0.4/traces`. |
| Is it receiving anything? | `grep 'traces received' <runtime>/logs/trace-agent.log` — a periodic summary from `pkg/trace/info/stats.go`, logged at **debug** level | A climbing count tagged `service:<yours>` is direct proof of receipt. Zero or absent means the tracer is not sending: confirm `dd-trace` is loaded in the application process, not merely installed. |
| Is `DD_API_KEY` set for the trace-agent? | The launcher prints `DD_API_KEY=set` or `MISSING` | The receiver accepts spans and the intake discards them. The application sees successful flushes. |
| Is the trace-agent path allowlisted? | Diff `applications.allowedSpawnCommands` against what `ensureTraceAgentBinary()` prints | Add the exact absolute path, then restart Harper. |

Under Harper, `dd-trace` also has to reach the worker threads. `threads.preloadRequire: dd-trace/init` is what initializes the tracer; `threads.preload: dd-trace/register.js` is additionally needed for HTTP instrumentation. Measured: `register.js` under `--import` alone initializes nothing, so the preload-only configuration yields a tracer-less process that looks correctly configured.

## Building from source (maintainers)

The upstream release is pinned in `.datadog-agent-version` (currently **7.82.1**) and both binaries are built from that one ref, since they share an IPC handshake and a config schema.

```bash
datadog-agent-build build                      # current platform, both binaries
datadog-agent-build build --datadog-version 7.82.1 -o ./build
datadog-agent-build install                    # (re)install this platform's binaries
datadog-agent-build platforms
datadog-agent-build version                    # pinned version, then latest upstream
```

One run produces both binaries. The builder iterates the platform's binary descriptors and runs one upstream task each:

| Binary | Task | Flags |
| --- | --- | --- |
| Core agent | `dda --no-interactive inv agent.build` | `--build-exclude=systemd,python --exclude-rtloader --no-enable-bazel` |
| Trace-agent | `dda --no-interactive inv trace-agent.build` | none |

**`--build-exclude` strips Go build tags and nothing more.** `tasks/agent.py` gates the embedded-rtloader install on a separate `exclude_rtloader` parameter, so every build before this one ran that install and then discarded its output. At 7.82.1 the install runs under bazel by default and extracts an LLVM toolchain the Linux code path never invokes, which exhausted the runner's disk before a Go file compiled. `--no-enable-bazel` is belt and braces: if a later tag reaches the install through another branch, it lands on the cmake path this project already provisions. Upstream uses the same pair in `packaging/aix/stages/04-agent.sh`.

Nothing a user can reach changes in the shipped core agent. `--build-exclude=python` already stripped the `python` build tag, so `pkg/collector/python` was never compiled in and the published binary already had no embedded CPython and no Python checks. The one artifact-level difference is that `get_build_flags` no longer bakes a build-tree RPATH into the binary: `get_rtloader_paths` returns nothing over the empty `dev/` the builder creates in place of the rtloader install's output. That is derived from the upstream source, not read off the ELF.

**The trace-agent descriptor takes none of these.** `TRACE_AGENT_TAGS` contains neither `python` nor `systemd`, and `tasks/trace_agent.py::build()` has no `embedded_path`, `rtloader_root`, or `exclude_rtloader` parameter. It is a plain `go_build`, and upstream's AIX packaging invokes it bare right after `agent.build --no-enable-bazel --exclude-rtloader`. Override either binary's flags with `DD_AGENT_BUILD_ARGS` or `DD_TRACE_AGENT_BUILD_ARGS`.

Upstream writes `<sourceDir>/bin/agent/agent` and `<sourceDir>/bin/trace-agent/trace-agent`; the builder copies them out as `datadog-agent` and `trace-agent`. A missing binary fails the build, naming the expected path and the task that produces it, rather than packaging a partial result.

### Requirements

Node `^22.18.0 || >=24.0.0`, Python 3.12+, CMake, Git, and a C toolchain: GCC on Linux, Xcode Command Line Tools on macOS, MinGW-w64 GCC on Windows. CMake is off the default build path now that `--exclude-rtloader` skips the install that used it; CI still provisions it so `--no-enable-bazel` has somewhere to land if a later tag reaches the rtloader install another way. Both binaries link glibc dynamically on Linux (the trace-agent's `netcgo` tag rules out a static build), and CI checks both against the floor.

**Go must match the source's `.go-version`** (7.82.x pins 1.26.5). The builder reads that file and refuses a *minor* mismatch, because Go's runtime and crypto defaults move between minors; a patch gap only warns. Without this check the three build paths drift independently — that is how source pinning Go 1.25.10 came to ship a `go1.26.4` binary.

Python appears twice here, and the two uses are unrelated:

- **Build-time Python is required for both binaries.** `dda` is a Python CLI and Datadog's build system is invoke-based. `trace-agent.build` is no exception: it runs `go generate -mod=<mode> <repo>/pkg/trace/info` before compiling (`tasks/trace_agent.py:59`). Install `dda` into an isolated environment — `uv tool install dda` or pipx — **never** with a bare `pip install --user`. dda finds its data files under the interpreter *prefix* (`sysconfig.get_path("data")`), while a user-site install writes them to the *user* scheme, so the two never meet and every command dies with `FileNotFoundError: .../dda-data/uv.lock`. On a PEP-668 Debian or Ubuntu image, `pip install dda` outside a venv fails with `externally-managed-environment` instead. The builder installs it this way for you and refuses the `pip` path outright.

Datadog pins a dda version in `.dda/version` in the agent source, and dda enforces it against itself: it reads that file from its working directory and aborts with `Repo requires at least dda version X` when it is older. It is a **minimum**, not an exact pin, so the newest dda is the right thing to install.
- **Python must not end up inside the core agent binary**, which is what `--build-exclude=systemd,python` prevents.

## Development

```bash
npm install
npm run build       # compile TypeScript
npm run typecheck
npm run build-agent # build both binaries for the current platform
npm test
npm run matrix      # what is published per platform, and whether it is correct
```

`npm run test:integration` runs the Harper-backed suite under `test/integration/` against a real `harper` process.

TypeScript 7 no longer auto-includes `node_modules/@types`, so `tsconfig.json` names `"types": ["node"]` explicitly. `@types/node` deliberately tracks the 22 line rather than the newest release: it must match the engines floor, or code calling an API absent from Node 22.18 compiles clean and fails for a consumer on the version we advertise.

### Branches

`main` is the default branch and the release branch; `dev` is where work integrates. A change branches off `dev`, opens a pull request into `dev`, and reaches `main` in a later pull request from `dev`. `main` is the repository default, so `gh pr create` aims there unless you pass `--base dev`.

A merge to `main` does not publish. Only a `v*` tag does, and nothing cuts one automatically: **Cut Prerelease** reports the version it would have cut and stops unless the `RELEASE_ENABLED` variable and a `REPO_TOKEN` PAT are both present, and neither is.

## Releasing

The git tag is the only input to the publish pipeline. It sets the npm version, and whether it parses as a semver prerelease decides the dist-tag, so a mistyped tag is a bad default install for every consumer rather than a typo. Push the tag deliberately; **Cut Prerelease** can compute and push it instead, but only once `RELEASE_ENABLED` is `true` and a `REPO_TOKEN` PAT exists, because a tag pushed with `GITHUB_TOKEN` starts no workflow.

The package version is its own line and carries no agent version. The bundled agent is pinned in `.datadog-agent-version`, which ships inside the tarball, so a consumer reads which agent they got instead of inferring it from the package number.

- **Prerelease:** a push to `main` runs **Cut Prerelease** on its own. It waits for that commit's `Test` run to go green, asks both the registry and the git tags which `-next.N` numbers are already taken, and pushes the next one. Running the workflow by hand defaults to a dry run; re-run with `dry_run=false` to push. Consumers get it with `npm install @deliciousmonster/datadog-agent-binary@next`.
- **Stable:** push a tag with no prerelease segment (`v1.0.1`). It publishes under `latest`.

A prerelease cannot move `latest`, with one exception the pipeline guards: on the very first publish npm sets `latest` regardless of `--tag`, because a package with no dist-tags needs one. The publish job asserts afterwards that `latest` is not the prerelease and fails if it is.

| Stage | Check |
| --- | --- |
| before publish | `npm test`, typecheck, and formatting |
| before publish | Both binaries built and smoke-tested per platform; the trace-agent must answer `/info` and accept a `v0.4` payload |
| before publish | `publish-matrix --local`: Node-valid `os`/`cpu`, no platform declared but unbuilt, no package missing the trace-agent |
| publish order | Platform packages first, then the main package. Reversed, the main package briefly advertises `optionalDependencies` that do not exist, silently |
| publish | Idempotent: already-published versions are skipped, so a partially failed tag can be re-run |
| after publish | `publish-matrix --registry --deep` against the real registry; the matrix is appended to the release notes |

**Authentication.** Trusted publishing is preferred: configure a trusted publisher on npmjs.com for this repo and `build-release.yml`, and leave `NPM_TOKEN` unset. The workflow has `id-token: write`, so npm exchanges the OIDC token for a short-lived credential and attaches build provenance. `NPM_TOKEN` is a bootstrap fallback only, for a first publish under a new scope where no trusted publisher can be configured yet; publish once, configure the publisher, delete the secret.

**Provenance needs a public source repository.** npm's prerequisite is a public `repository` field matching where the publish runs from. `release-preflight.js` compares the slug and not the visibility, so a private repository clears preflight and then fails at `npm publish --provenance`, after every platform's Go build.

## License

Apache License 2.0, as are the binaries this package builds and distributes: see the [Datadog Agent repository](https://github.com/DataDog/datadog-agent), whose source is copyrighted by Datadog, Inc.
