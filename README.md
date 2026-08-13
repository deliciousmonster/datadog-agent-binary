# Datadog Agent Binary

[![Datadog Agent Binaries](https://github.com/deliciousmonster/datadog-agent-binary/actions/workflows/build-release.yml/badge.svg)](https://github.com/deliciousmonster/datadog-agent-binary/actions/workflows/build-release.yml)

Distributes the pre-compiled [Datadog Agent](https://github.com/DataDog/datadog-agent) as an npm package, so the agent is installed and versioned as a normal Node dependency instead of through a system package manager or a container sidecar. Intended for running the agent alongside a Node application, including inside Harper v5.

**Two binaries ship, because upstream builds two and offers no flag to fold one into the other.**

| Binary | What it is | Command | Accessor | Harper spawn `name` |
| --- | --- | --- | --- | --- |
| `datadog-agent` | Core agent: host metrics, checks, log forwarding, DogStatsD. | `datadog-agent` | `getBinaryPath()` | `datadog-agent` |
| `trace-agent` | APM receiver. Binds `127.0.0.1:8126` and accepts spans from `dd-trace`. | `datadog-trace-agent` | `getTraceAgentBinaryPath()` | `datadog-trace-agent` |

**If traces never show up in Datadog, the trace-agent is the answer.** `dd-trace` posts spans to `127.0.0.1:8126` and treats a failed flush as nothing worth reporting. With no process on that port the tracer still creates spans, still flushes on schedule, and drops every one of them: the application logs nothing and exits normally. Releases before the trace-agent was added shipped the core agent alone, which produces exactly that symptom. See [Troubleshooting](#troubleshooting-no-traces-in-datadog).

Both files live in the same platform package as `bin/datadog-agent` and `bin/trace-agent` (`.exe` suffix on Windows). The commands are npm `bin` entries, on `PATH` via `node_modules/.bin` once installed.

## What it does

- Installs both binaries for the current platform through `optionalDependencies`. No install scripts, no download at install time.
- Provides `datadog-agent` and `datadog-trace-agent` commands that resolve their binary and run it, passing arguments and environment through unchanged, and passing the `name` option Harper v5's spawn enforcement requires.
- Logs binary resolution, the spawn (path, args, PID), exit status, and which Datadog env vars are present. `DD_API_KEY` is reported as `set`/`MISSING`, never by value.
- Checks the trace-agent's two pre-bind failure conditions before spawning it, so a bad config path fails in one line instead of a 30 second hang.
- Builds both binaries from Datadog source for Linux, Windows, and macOS.

It does not configure Datadog. API key, site, and collection settings are supplied the usual way, through environment variables or `datadog.yaml`.

## Installation

```bash
npm install @deliciousmonster/datadog-agent-binary
```

The main package is platform-agnostic and declares one `optionalDependency` per platform (`@deliciousmonster/datadog-agent-binary-linux-x86_64` and friends), each tagged with npm `os`/`cpu`. `npm install` fetches only the package matching your machine, and that package carries both binaries.

> **Bootstrap: the `@deliciousmonster` platform packages are not published yet.** Because the dependencies are *optional*, npm skips them silently and `npm ci` still exits 0; `node_modules/@deliciousmonster/` is never created and there is no install-time warning. The first symptom is at runtime, where `BinaryManager` finds no packaged binary and falls through to the build-from-source path. Publish the platform packages first (the release workflow already orders it that way), then regenerate `package-lock.json` so the lock carries real integrity hashes instead of the `{ "optional": true }` placeholders npm records for an unresolvable package.

## Observability coverage

| Pillar | Status | What you get, and what you don't |
| --- | --- | --- |
| Metrics | On by default | Go corechecks (`cpu`, `memory`, `disk`, `io`, `load`, `uptime`, `filehandles`, `network`, `ntp`) and DogStatsD, as soon as the core agent runs with an API key. **No Python integrations**: the build excludes the `python` tag, so `postgres`, `redis`, `nginx`, and the rest of `datadog_checks.*` are absent from the binary. |
| Logs | Supported, off by default | `DD_LOGS_ENABLED` defaults to `false`, and turning it on is not sufficient: the Agent also needs a `conf.d` file source. See [Log collection](#log-collection-harper-hdblog). |
| Traces | Via the trace-agent | Needs `dd-trace` loaded in the application *and* the trace-agent running. Either alone produces no traces and no error. |

The `python` exclusion is forced. Linking the embedded CPython gives a binary that resolves librtloader through an rpath into the build tree, so it runs only on the machine that built it. A relocatable npm artifact and Python integrations are mutually exclusive under this build.

## Usage

### Running the agents

```bash
# Core agent: metrics, checks, log forwarding, DogStatsD. -c takes a DIRECTORY.
datadog-agent run -c /path/to/datadog-config-dir
datadog-agent status
datadog-agent version

# Trace-agent: APM receiver on 127.0.0.1:8126. -c takes the FILE.
datadog-trace-agent run -c /path/to/datadog.yaml
datadog-trace-agent version
```

All arguments and environment pass straight through, so any subcommand either agent supports works. They are independent processes and neither starts the other: `datadog-agent run` alone gives metrics and logs with no APM; `datadog-trace-agent run` alone gives APM with no host metrics. Most deployments want both.

**Always pass the trace-agent a `-c`.** Its default is not the core agent's `/etc/datadog-agent/datadog.yaml` but `<install path>/etc/datadog.yaml`, derived at runtime from where the executable sits, which for a binary npm unpacked into `node_modules` is somewhere with no `datadog.yaml` and no reason to have one. Two requirements its own failure output does not name:

- **The file must exist.** Contents are irrelevant to startup; a 0-byte file is enough. Without it the process exits immediately with `unable to load Datadog config file`.
- **Its directory must be writable by the running user**, because the agent writes its `auth_token` there. Without write access it hangs 30 seconds and dies with `error while creating or fetching auth token`. On non-root deploy targets `/etc/datadog-agent` is not writable, so point `-c` at a path the process owns.

The `datadog-trace-agent` wrapper checks both before spawning and names the offending path. With an explicit `-c` a failed check is fatal; with an inferred path it only warns, since refusing on a guess would block a launch that would have worked. For `run` it also asks `/info` whether a receiver is already up, and exits 0 if one is. It asks `/info` rather than opening a TCP connection because a bare probe reports success whenever anything holds the port, including when the trace-agent is not installed at all, which is indistinguishable from the bug this package exists to fix.

### Connecting to Datadog

| Variable | Purpose | Notes |
| --- | --- | --- |
| `DD_API_KEY` | Authenticates to Datadog | Without it the agent starts but **disables** its connection. Nothing is sent. |
| `DD_SITE` | Destination site | `datadoghq.com` (default), `datadoghq.eu`, … |
| `DD_ENV` | `env` tag on all data | e.g. `production`. |
| `DD_LOGS_ENABLED` | Log collection on/off | Defaults to `false`. |
| `DD_LOG_TO_CONSOLE` | Agent's own logs to stdout | Defaults to `true`. |
| `DD_APM_ENABLED` | APM receiver on/off in the trace-agent | Defaults to `true`. |
| `DD_APM_RECEIVER_PORT` | Port the trace-agent binds | Defaults to `8126`. |
| `DD_TRACE_AGENT_URL` | Where `dd-trace` sends spans | Read by the tracer, not the agent. Defaults to `http://127.0.0.1:8126`. |

`DD_APM_RECEIVER_PORT` and `DD_TRACE_AGENT_URL` have to agree. A mismatch drops every span with no error on either side: the tracer gets a connection failure it does not surface, and the receiver never sees a request.

A keyless trace-agent gets its own startup warning, because it is the most deceptive case. It binds the receiver and accepts spans normally, and only the intake rejects them, so the tracer sees a successful flush and an empty APM view is the only symptom.

Full list: [Agent environment variables](https://docs.datadoghq.com/agent/guide/environment-variables/).

### Log collection (Harper `hdb.log`)

A template ships at [`conf.d/harperdb.d/conf.yaml.example`](conf.d/harperdb.d/conf.yaml.example). Copy it into the Agent's `conf.d` (or point `confd_path`/`DD_CONFD_PATH` at it); if your component generates the Agent config at startup, emit the same block from code.

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

Measured against a real `hdb.log`: 185,440 physical lines collapse to 15,952 events. The rule works regardless of the `source` tag, so `source` is optional; set `source: harperdb` only if you intend to build a Datadog pipeline that parses these plain-text lines.

### Programmatic usage

```typescript
import { BinaryManager } from "@deliciousmonster/datadog-agent-binary";

const manager = new BinaryManager();
const corePath = await manager.ensureBinary(); // core agent
const tracePath = await manager.ensureTraceAgentBinary(); // trace-agent
```

`ensureBinary(kind?, version?)` takes the binary kind first and the version second, so `ensureBinary("trace")` and `ensureTraceAgentBinary()` are the same call. No arguments still resolves the core agent.

Each resolves through the platform package's accessor, falling back to a locally built binary for the source-build workflow. A platform package published before the trace-agent existed has no `getTraceAgentBinaryPath()`; `ensureTraceAgentBinary()` says so by name rather than failing generically.

## Supported platforms

| OS | Architecture | Status |
| --- | --- | --- |
| Linux | x86_64 | ✅ |
| Linux | arm64 | ✅ |
| macOS | arm64 | ✅ |
| Windows | x86_64 | ✅ |
| macOS | x86_64 | 🚫 GitHub retired the `macos-13` Intel runner |
| Windows | arm64 | 🚫 [Chocolatey](https://chocolatey.org) has no native arm64 |

This set must match `SUPPORTED_PLATFORMS` in `src/platform.ts` and the build matrix in `.github/workflows/build-release.yml`. A platform listed in `SUPPORTED_PLATFORMS` becomes an `optionalDependency`, so if no matrix leg builds it, npm skips the missing package at install time **without an error** and the consumer gets no binaries and no explanation. `npm run matrix` checks this.

Restoring macOS x86_64 needs a build leg (self-hosted Intel, or a verified darwin/amd64 cross-compile with CGO on, which the `netcgo` build tag requires) added in the same change as the `SUPPORTED_PLATFORMS` entry.

## Harper v5 (Lincoln)

### Allowlist both paths

Harper v5 only lets a component `spawn`/`exec` an executable that is launched with a `name` option and listed by its exact absolute path in `applications.allowedSpawnCommands`. **There are two paths now.** Allowlisting only the core agent reproduces the original symptom: metrics and logs flow, the trace-agent spawn is rejected, traces vanish, nothing looks broken.

Print the real paths:

```js
const { BinaryManager } = require("@deliciousmonster/datadog-agent-binary");
const m = new BinaryManager();
console.log(await m.ensureBinary()); // core
console.log(await m.ensureTraceAgentBinary()); // trace
```

Then add both to `harperdb-config.yaml`:

```yaml
applications:
  allowedSpawnCommands:
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

Two ways this fails silently:

- **The match is an exact string compare on the first space-delimited token.** Harper takes `command.split(' ')[0]` and asks whether the allowlist set contains it. A bare command name never matches, a relative path never matches, and a path containing a space can never match at all, since the token is truncated at the space. Install somewhere without spaces.
- **The allowlist is read once at module load.** Editing `harperdb-config.yaml` while Harper runs changes nothing. Restart it.

The paths carry no version number, so they survive a package upgrade.

### The singleton, and why the launchers do not get it

Harper dedupes spawns with an exclusive PID-file lock: it opens `<rootPath>/pids/<name>.pid` with `wx`, so the first caller wins and everyone else gets `EEXIST`. The lock is on the filesystem, so it dedupes across worker threads and across processes. Two distinct names take two independent locks, which is why one core agent and one trace-agent coexist while neither is ever started twice. Verified against Harper 5.2.1: four worker threads produce one spawn and one PID file per name.

**The shipped `datadog-agent` / `datadog-trace-agent` launchers do not get any of this.** Harper substitutes its constrained `child_process` only for modules its own loader evaluates, and only on the ESM path: its CommonJS bridge forwards a builtin specifier straight to Node's real `require`, and this package's `dist/` is CommonJS. So when a launcher calls `spawn(..., { name })`, stock Node ignores `name`. No lock, no allowlist check, no `ExistingProcessWrapper`. One agent per worker thread.

To get the singleton, the spawn must live in **your component's own module graph**, reached by a **relative ESM import** from your entry file:

```js
// resources.js: Harper loads this, so its relative imports go through Harper's loader
import { startDatadogAgents } from "./dd-supervisor.js";

// dd-supervisor.js
import { spawn } from "node:child_process"; // ESM import, NOT require()
```

[`example/`](example/) is a working implementation, including a startup self-check that proves interception is live and fails loudly otherwise. Copy that pattern rather than shelling out to the launchers. Two consequences it handles:

- **The loser of the race does not get a `ChildProcess`.** It gets a handle with `pid`, `kill()`, `unref()`, and an `'exit'` event, and nothing else, so `child.stdout.on(...)` without a guard throws a `TypeError` on every thread but the winner. That handle also runs an un-unref'd 1 Hz liveness interval, so a joining thread never goes idle until it calls `child.unref()`.
- **`version` forces a replacement, and it must be a number.** If it differs from the value in the PID file, Harper kills the running process and spawns a new one. Harper parses the recorded value with `parseInt`, so a *string* version never compares equal to itself and every thread would SIGTERM and respawn forever.

Harper installs packages with `--ignore-scripts` by default. This package and its platform sub-packages do not use install scripts, so `applications.allowInstallScripts` is not needed.

`DatadogAgentBuilder` shells out to `dda`, `go`, and `pip`; it is for a developer shell or a CI runner, never inside a Harper-managed process.

## Troubleshooting: no traces in Datadog

Spans are dropped quietly at every stage. Work down in order; the first failing check is the answer.

| Check | How | If it fails |
| --- | --- | --- |
| Is the trace-agent running? | `pgrep -fl trace-agent` | Nothing is receiving spans. Start `datadog-trace-agent run -c <config>` and read the launcher output for a preflight failure or a rejected spawn. |
| Is the receiver answering? | `curl -s http://127.0.0.1:8126/info` | Compare `DD_APM_RECEIVER_PORT` against the tracer's `DD_TRACE_AGENT_URL`, and confirm `DD_APM_ENABLED` is not `false`. A healthy response lists `/v0.4/traces`. |
| Is it receiving anything? | `traces received: N` in the trace-agent's own log | `N` stuck at 0 means the tracer is not sending. Confirm `dd-trace` is loaded in the application process, not merely installed. |
| Is `DD_API_KEY` set for the trace-agent? | The launcher prints `DD_API_KEY=set` or `MISSING` | The receiver accepts spans and the intake discards them. The application sees successful flushes. |
| Is the trace-agent path allowlisted? | Diff `applications.allowedSpawnCommands` against what `ensureTraceAgentBinary()` prints | Add the exact absolute path, then restart Harper. |

Under Harper, `dd-trace` also has to reach the worker threads. `threads.preloadRequire: dd-trace/init` is what initializes the tracer; `threads.preload: dd-trace/register.js` is additionally needed for HTTP instrumentation. Measured: `register.js` under `--import` alone initializes nothing, so the preload-only configuration yields a tracer-less process that looks correctly configured.

## Building from source (maintainers)

The upstream release is pinned in `.datadog-agent-version` and both binaries are built from that one ref, since the core agent and trace-agent share an IPC handshake and a config schema.

```bash
datadog-agent-build build                                   # current platform, both binaries
datadog-agent-build build --datadog-version 7.79.1 -o ./build
datadog-agent-build install                                 # (re)install this platform's binaries
datadog-agent-build platforms                               # supported platforms
datadog-agent-build version                                 # pinned version, then latest upstream
```

```typescript
import { DatadogAgentBuilder } from "@deliciousmonster/datadog-agent-binary";

const result = await new DatadogAgentBuilder().buildForCurrentPlatform({
	version: "7.79.1",
	outputDir: "./build",
});
```

Options are `version?`, `outputDir?`, and `buildArgs?`. `BuildResult` carries `outputPaths` (every binary, keyed by kind) alongside `outputPath`, which still points at the core agent.

One run produces both binaries. The builder iterates the platform's binary descriptors and runs one upstream task each:

| Binary | Task | Flags |
| --- | --- | --- |
| Core agent | `dda --no-interactive inv agent.build` | `--build-exclude=systemd,python` |
| Trace-agent | `dda --no-interactive inv trace-agent.build` | none |

**The trace-agent takes no `--build-exclude`, and passing the core agent's would be wrong rather than redundant.** `TRACE_AGENT_TAGS` contains neither `python` nor `systemd`, and `tasks/trace_agent.py::build()` has no `embedded_path`, `rtloader_root`, or `exclude_rtloader` parameter. It is a plain `go_build`, so there is nothing for those excludes to act on. Override either binary's flags for a run with `DD_AGENT_BUILD_ARGS` or `DD_TRACE_AGENT_BUILD_ARGS`.

Upstream writes `<sourceDir>/bin/agent/agent` and `<sourceDir>/bin/trace-agent/trace-agent`; the builder copies them out as `datadog-agent` and `trace-agent`. A missing binary fails the build, naming the expected path and the task that produces it, rather than packaging a partial result.

### Requirements

Go matching the agent's `go.mod` (7.79.x needs Go 1.25.x), Node 18+, Python 3.12, CMake, Git, and a C toolchain: GCC on Linux, Xcode Command Line Tools on macOS, MinGW-w64 GCC on Windows. CMake is core-agent-only; it builds rtloader, which the trace-agent does not link. Both binaries link glibc dynamically on Linux (the trace-agent's `netcgo` tag rules out a static build), and CI checks both against the floor.

Python appears twice here, and the two uses are unrelated:

- **Build-time Python is required for both binaries.** `dda` is a Python CLI and Datadog's build system is invoke-based. `trace-agent.build` is no exception: at 7.79.1 it runs `go generate -mod=<mode> <repo>/pkg/trace/info` before compiling (`tasks/trace_agent.py:59`). Install `dda` into a virtualenv or via pipx, never with a bare `pip install --user`: a user-site install resolves its data directory to the interpreter prefix while pip writes to `~/.local/share`, so every command dies with `FileNotFoundError: .../share/dda-data/uv.lock`. On a PEP-668 Debian or Ubuntu image, `pip install dda` outside a venv fails with `externally-managed-environment`.
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

## Releasing

The git tag is the only input to the publish pipeline. It sets the npm version, and whether it parses as a semver prerelease decides the dist-tag, so a mistyped tag is a bad default install for every consumer rather than a typo.

- **Prerelease:** run the **Cut Prerelease** workflow. It asks the registry which `-next.N` versions exist, computes the next one, and pushes the tag. Default is a dry run; re-run with `dry_run=false` to push. Consumers get it with `npm install @deliciousmonster/datadog-agent-binary@next`.
- **Stable:** push a tag with no prerelease segment (`v7.75.6`). It publishes under `latest`.

A prerelease publishes under `next` and cannot move `latest`, with one exception the pipeline guards: on the very first publish of a package npm sets `latest` regardless of `--tag`, because a package with no dist-tags needs one. The publish job asserts afterwards that `latest` is not the prerelease and fails if it is.

| Stage | Check |
| --- | --- |
| before publish | `npm test`, typecheck, and formatting (the `test` gate job) |
| before publish | Both binaries built and smoke-tested per platform; the trace-agent must answer `/info` and accept a `v0.4` payload |
| before publish | `publish-matrix --local`: Node-valid `os`/`cpu`, no platform declared but unbuilt, no package missing the trace-agent |
| publish order | Platform packages first, then the main package. Reversed, the main package briefly advertises `optionalDependencies` that do not exist, and that failure is silent |
| publish | Idempotent: already-published versions are skipped, so a partially failed tag can be re-run |
| after publish | `publish-matrix --registry --deep` against the real registry; the matrix is appended to the release notes |

**Authentication.** Trusted publishing is preferred: configure a trusted publisher on npmjs.com for this repo and `build-release.yml` and leave `NPM_TOKEN` unset. The workflow has `id-token: write`, so npm exchanges the OIDC token for a short-lived credential and attaches build provenance. `NPM_TOKEN` is a bootstrap fallback only, for a first publish under a new scope where no trusted publisher can be configured yet; publish once, configure the publisher, delete the secret.

## License

Apache License 2.0, as are the binaries this package builds and distributes: see the [Datadog Agent repository](https://github.com/DataDog/datadog-agent), whose source is copyrighted by Datadog, Inc.
