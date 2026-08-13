# Datadog Agent Binary

[![Datadog Agent Binaries](https://github.com/HarperFast/datadog-agent-binary/actions/workflows/build-release.yml/badge.svg)](https://github.com/HarperFast/datadog-agent-binary/actions/workflows/build-release.yml)

Distributes the pre-compiled [Datadog Agent](https://github.com/DataDog/datadog-agent) as an npm package, so the agent can be installed and versioned as a normal Node dependency instead of through a system package manager or container sidecar. This is intended for running the agent alongside a Node application, including inside Harper v5.

Two processes ship here, because upstream builds them as two separate binaries and offers no option to fold one into the other:

- **Core agent** (`datadog-agent`): host metrics, checks, log forwarding, DogStatsD.
- **Trace-agent** (`trace-agent`): the APM receiver. This is the process that binds `127.0.0.1:8126` and accepts spans from `dd-trace`.

**If you are here because traces never show up in Datadog, the trace-agent is the answer.** `dd-trace` posts spans to `127.0.0.1:8126` and treats a failed flush as nothing worth reporting. With no process on that port the tracer still creates spans, still flushes on schedule, and drops every one of them; the application logs nothing and exits normally. Releases of this package before the trace-agent was added shipped the core agent alone, which produces exactly that symptom. See [Troubleshooting: no traces in Datadog](#troubleshooting-no-traces-in-datadog).

The repo covers two things:

- **Runtime:** the installed binaries for the current platform and a command to run each one. This is what consumers depend on.
- **Build:** tooling to compile both binaries from Datadog source for each supported platform, used to produce the published packages. Most consumers don't need this.

## The binaries

| Binary | What it is | Command | Accessor | Harper spawn `name` |
|---|---|---|---|---|
| `datadog-agent` | Core agent. Metrics, checks, log forwarding, DogStatsD. | `datadog-agent` | `getBinaryPath()` | `datadog-agent` |
| `trace-agent` | APM receiver. Binds `127.0.0.1:8126`, accepts spans from `dd-trace`. | `datadog-trace-agent` | `getTraceAgentBinaryPath()` | `datadog-trace-agent` |

Both files live in the same platform package, as `bin/datadog-agent` and `bin/trace-agent` (`.exe` suffix on Windows). The accessors are exported by that platform package and are what `BinaryManager` calls; the commands are npm `bin` entries, on `PATH` as `node_modules/.bin` entries once the package is installed.

The two spawn names are deliberately different. Harper's dedupe is keyed on that name, so distinct names give one core agent **and** one trace-agent per node rather than one process total. See [Singleton behaviour under Harper](#singleton-behaviour-under-harper).

## What it does

- Installs both agent binaries for the current platform via `optionalDependencies`. The main package is platform-agnostic and declares one optional dependency per platform (e.g. `@deliciousmonster/datadog-agent-binary-linux-x86_64`), each tagged with npm `os`/`cpu`, so `npm install` fetches only the matching one. No install scripts; no download at install time.
- Provides a `datadog-agent` and a `datadog-trace-agent` command that each resolve their binary and run it, passing arguments and environment through unchanged.
- Passes the `name` option that Harper v5's spawn enforcement requires, so both processes can be launched from a Harper component. See [Harper v5 compatibility](#harper-v5-lincoln-compatibility).
- Logs binary resolution, the spawn (path, args, PID), exit status, and which Datadog environment variables are present, which is what makes "no data reaches Datadog" diagnosable. The `DD_API_KEY` value is not logged, only whether it is set. See [Startup logging](#startup-logging).
- Checks the trace-agent's two pre-bind failure conditions before spawning it, so a missing config file or an unwritable config directory fails in one line instead of a fatal error or a 30 second hang from the agent itself.
- Builds both binaries from source for Linux, Windows, and macOS on arm64 and amd64 (the working subset).

It does not configure Datadog. API key, site, and collection settings are provided the usual Datadog way, through environment variables or `datadog.yaml`. See [Connecting to Datadog](#connecting-to-datadog) and [Observability coverage](#observability-coverage) for what this package can and cannot deliver once configured.

## Installation

```bash
npm install @deliciousmonster/datadog-agent-binary
```

Installing pulls in the pre-built binaries for your platform automatically via `optionalDependencies`; only the package whose `os`/`cpu` match your machine is fetched, and it carries both the core agent and the trace-agent.

> **Bootstrap: the `@deliciousmonster` platform packages are not published yet.**
>
> `optionalDependencies` names all five under the new scope, and none of them exist on the
> registry today. Because the dependencies are *optional*, **npm skips them silently and
> `npm ci` still exits 0** — `node_modules/@deliciousmonster/` is simply never created. There
> is no warning at install time. The first symptom is at runtime, where `BinaryManager` finds
> no packaged binary and falls through to the build-from-source path.
>
> Confirm with:
>
> ```bash
> npm ci && ls node_modules/@deliciousmonster/     # expect: no such directory, today
> ```
>
> Until the platform packages are published under this scope, either publish them first (the
> release workflow already publishes platform packages before the main package, so the
> ordering is handled) or point `optionalDependencies` back at a scope that exists. Regenerate
> `package-lock.json` after the first publish so the lock carries real integrity hashes instead
> of the `{ "optional": true }` placeholders npm records for an unresolvable package.

## Usage

### Running the agents

```bash
# Core agent: metrics, checks, log forwarding, DogStatsD
datadog-agent run
datadog-agent status
datadog-agent version

# Trace-agent: APM receiver on 127.0.0.1:8126
datadog-trace-agent run -c /path/to/datadog.yaml
datadog-trace-agent version
```

All arguments and environment variables are passed straight through to the underlying binary, so any subcommand either agent supports works.

They are independent processes and neither starts the other. Running only `datadog-agent run` gives you metrics and logs with no APM; running only `datadog-trace-agent` gives you APM with no host metrics. Most deployments want both.

The trace-agent has two requirements that are easy to miss because its own failure output does not name them:

- **`datadog.yaml` must exist.** Its contents are irrelevant to startup; a 0-byte file is enough. Without it the process exits immediately with `unable to load Datadog config file`.
- **The directory holding it must be writable by the running user.** The agent writes its `auth_token` there. Without write access it hangs for 30 seconds and then dies with `error while creating or fetching auth token`. This matters on non-root deploy targets, where `/etc/datadog-agent` is not writable, so point `-c` at a path under a directory the process owns.

**Pass `-c` explicitly.** The trace-agent's default config path is not the core agent's `/etc/datadog-agent/datadog.yaml`; it is `<install path>/etc/datadog.yaml`, and the install path is derived at runtime from where the executable sits. For a binary npm unpacked into `node_modules` that lands somewhere with no `datadog.yaml` in it and no reason to have one.

The `datadog-trace-agent` wrapper checks both requirements before spawning and reports the offending path. When you pass `-c`, a failed check is fatal: it knows what the agent will read, and refusing costs one log line instead of thirty seconds of a process that looks alive. When you do not, the wrapper infers the path from the binary and only warns, since refusing on an inferred path would block a launch that would have worked.

For `run` specifically, it also checks whether a receiver is already up — but only **after** resolving the binary, and by asking `/info` rather than by opening a TCP connection. A healthy receiver means starting a second one is unnecessary, so the wrapper logs that and exits 0. A port that accepts connections but does not answer `/info` is not a receiver, so it warns and starts the agent anyway, letting a real `EADDRINUSE` surface.

The ordering and the `/info` check are both deliberate. A bare TCP probe placed before resolution would report success whenever anything held the port, including when the trace-agent binary was not installed at all — which is indistinguishable from the bug this package exists to fix. Resolution failures are always loud.

### Connecting to Datadog

This package ships the binaries; **configuring** them is independent of this package and done the standard Datadog way. The variables that matter most:

| Variable | Purpose | Notes |
|---|---|---|
| `DD_API_KEY` | Authenticates to Datadog | Without it the agent starts but **disables** its connection — nothing is sent. |
| `DD_SITE` | Destination site | e.g. `datadoghq.com`, `datadoghq.eu`. Defaults to `datadoghq.com`. |
| `DD_ENV` | `env` tag on all data | e.g. `production`, `development`. |
| `DD_LOGS_ENABLED` | Enables **log collection** | Defaults to `false` — logs only forward when set to `true`. Separate from the agent connecting at all. |
| `DD_LOG_TO_CONSOLE` | Agent's own logs to stdout | Defaults to `true`. |
| `DD_APM_ENABLED` | APM receiver on/off in the trace-agent | Defaults to `true`. |
| `DD_APM_RECEIVER_PORT` | Port the trace-agent binds | Defaults to `8126`. |
| `DD_TRACE_AGENT_URL` | Where `dd-trace` sends spans | Read by the tracer, not by the agent. Defaults to `http://127.0.0.1:8126`. |

`DD_APM_RECEIVER_PORT` and `DD_TRACE_AGENT_URL` have to agree. A mismatch drops every span with no error on either side: the tracer gets a connection failure it does not surface, and the receiver never sees a request.

See Datadog's [Agent environment variables](https://docs.datadoghq.com/agent/guide/environment-variables/) for the full list, or use a `datadog.yaml`.

### Log collection (Harper `hdb.log`)

To forward Harper's logs, enable log collection (`DD_LOGS_ENABLED=true` or `logs_enabled: true`) and give the Agent a file source that tails `hdb.log`. A ready-to-edit template ships with this package at [`conf.d/harperdb.d/conf.yaml.example`](conf.d/harperdb.d/conf.yaml.example).

The Agent reads this from a `conf.d/harperdb.d/conf.yaml` file — there are two ways to get it there:

- **Standalone Agent:** copy the template into the Agent's `conf.d` (or point `confd_path` / `DD_CONFD_PATH` at it) and set `path`/`service` for your deployment.
- **Launcher that writes the config in code:** if your component generates the Agent config at startup (sets `confd_path` and writes `conf.d/harperdb.d/conf.yaml`), add the same `logs:` block below — including the `multi_line` rule — to the config it writes. It's the same file, just generated instead of hand-placed.

**Harper logs are multi-line plain text — use a `multi_line` rule.** `hdb.log` is not JSON. A single event starts with an ISO-8601 timestamp and its stack traces / pretty-printed error objects continue on following lines that do *not* start with a timestamp:

```
2026-05-22T22:28:41.020Z [main/0] [warn] [analytics]: Error ... ENOENT ...
    at Object.readdirSync (node:fs:1583:26)
    at storeDBSizeMetrics (.../analytics/write.ts:327:31)
  code: 'ENOENT',
}
```

By default the Agent treats every physical line as its own log, so each `at ...`/`code:` line arrives in Datadog as a separate entry — the "logs coming in line by line" symptom. The fix is an Agent-side `multi_line` rule that starts a new entry only when a line begins with a timestamp and appends everything else to it:

```yaml
logs:
  - type: file
    path: "/path/to/harper/log/hdb.log"   # {ROOTPATH}/log/hdb.log
    service: "harper"                       # match DD_SERVICE
    log_processing_rules:
      - type: multi_line
        name: harper_new_log_starts_with_timestamp
        pattern: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'   # auto-anchored to line start; no leading ^
```

Verified end to end against a real `hdb.log` with the bundled Agent: 185,440 physical lines collapse to 15,952 events, and a multi-line stack trace ships as a single log entry (its `message` contains all the `at ...` lines).

The `multi_line` rule is the actual fix, and it works **regardless of the `source` tag** — setting `source: harperdb` neither causes nor fixes the line splitting. `source` is therefore optional: leave it off, or set `source: harperdb` if you plan to build a custom Datadog log pipeline to parse these plain-text logs (extract level, thread, etc.). (If Harper is ever reconfigured to emit one JSON object per line, you can drop the `multi_line` rule and let Datadog parse the JSON natively instead.)

### Startup logging

Both launchers share one implementation and emit the same diagnostics at `info`/`warn` (visible without any debug flag) before and around the spawn:

- the detected platform/arch and the resolved binary path, or a warning if no platform package is installed;
- the spawn itself (binary path, args, child PID) and the exit code or terminating signal;
- which Datadog env vars are present: `DD_API_KEY` (reported only as `set`/`MISSING`, never the value), `DD_SITE`, `DD_ENV`, `DD_HOSTNAME`, `DD_LOGS_ENABLED`, `DD_LOG_TO_CONSOLE`;
- the APM env separately, since it is a different socket from everything above: `DD_APM_ENABLED`, `DD_APM_RECEIVER_PORT`, `DD_TRACE_AGENT_URL`;
- for the trace-agent, the config preflight result, and a note when it joined a receiver that was already listening instead of starting one;
- a clear error naming the path to allowlist if Harper's spawn enforcement rejects the launch.

This makes the common failure modes ("agent disabling," "no logs flowing," "no traces arriving," "spawn blocked") diagnosable straight from the container logs.

A keyless trace-agent gets its own warning, because it is the most deceptive case: it binds the receiver and accepts spans normally, and only the intake rejects them. The tracer sees a successful flush either way, so an empty APM view is the only symptom.

### Programmatic usage

```typescript
import { BinaryManager } from '@deliciousmonster/datadog-agent-binary';

// Resolve the platform binaries installed via optionalDependencies.
const manager = new BinaryManager();
const corePath = await manager.ensureBinary();             // core agent
const tracePath = await manager.ensureTraceAgentBinary();  // trace-agent (APM receiver)
```

`ensureBinary()` takes the binary kind as its first argument and the version as its second: `ensureBinary("trace")` and `ensureTraceAgentBinary()` are the same call. Calling it with no arguments still resolves the core agent, so existing code keeps working.

Each resolves through the platform package's accessor (`getBinaryPath()` / `getTraceAgentBinaryPath()`), falling back to a locally built binary for the source-build workflow. A platform package published before the trace-agent existed has no `getTraceAgentBinaryPath()`; `ensureTraceAgentBinary()` says so by name rather than failing generically.

## Observability coverage

The three pillars do not behave the same way here, and the differences are a recurring source of confusion. What this package can and cannot deliver:

| Pillar | Status | What you get, and what you don't |
|---|---|---|
| **Metrics** | Yes, on by default | Go corechecks (`cpu`, `memory`, `disk`, `io`, `load`, `uptime`, `filehandles`, `network`, `ntp`) plus DogStatsD, as soon as the core agent runs with an API key. **No Python-based integrations.** The build excludes the `python` tag, so `postgres`, `redis`, `nginx`, and the whole `datadog_checks.*` family are absent from the binary. Infrastructure metrics yes; integration metrics no. |
| **Logs** | Yes, but off by default | `DD_LOGS_ENABLED` defaults to `false`, so setting nothing forwards nothing. Turning it on is not sufficient either: the agent needs a file source in `conf.d`, and there is no environment variable that declares one. See [Log collection](#log-collection-harper-hdblog) for the template that ships with this package. |
| **Traces** | Yes, via the trace-agent | Requires two things at once: `dd-trace` loaded in the application, and the trace-agent process running to receive what it sends. Either one alone produces no traces and no error. |

The `python` exclusion is not incidental. Linking the embedded CPython gives a binary that resolves librtloader through an rpath into the build tree, so it runs only on the machine that built it. A relocatable npm artifact and Python integrations are mutually exclusive under this build.

## Supported platforms

| OS | Architecture | Status |
|----|-------------|--------|
| Linux | x86_64 | ✅ |
| Linux | arm64 | ✅ |
| Windows | x86_64 | ✅ |
| Windows | arm64 | 🚫 |
| macOS | x86_64 | ✅ |
| macOS | arm64 | ✅ |

Windows arm64 is blocked by [Chocolatey](https://chocolatey.org) not supporting arm64 natively.

## Harper v5 (Lincoln) compatibility

Running the agents from inside a Harper v5 application has two requirements; this package handles one of them and the consuming app handles the other.

### Spawning the agents from a Harper component

Harper v5 only lets a component `spawn`/`exec` an executable that is (a) launched with a `name` option (so Harper can dedupe the child across worker threads) and (b) listed by its **exact absolute path** in `applications.allowedSpawnCommands`.

The consuming app must allowlist the paths. **There are two of them now.** Allowlisting only the core agent is the failure that reproduces the original symptom: the core agent starts, metrics and logs flow, the trace-agent spawn is rejected, and traces vanish with nothing obviously broken.

Allowlisting is necessary but not sufficient — the spawn also has to reach Harper's gate in the first place. See [Singleton behaviour under Harper](#singleton-behaviour-under-harper): the shipped CLI launchers bypass it, so component code must spawn the binaries itself.

Resolve both the same way the launchers do:

```js
const { BinaryManager } = require('@deliciousmonster/datadog-agent-binary');
const m = new BinaryManager();
console.log(await m.ensureBinary());              // core
console.log(await m.ensureTraceAgentBinary());    // trace
```

Then add both exact paths to `harperdb-config.yaml`:

```yaml
applications:
  allowedSpawnCommands:
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

Two gotchas, both of which fail silently rather than loudly:

- **The match is an exact string compare on the first space-delimited token of the command.** Harper takes `command.split(' ')[0]` and asks whether the allowlist set contains it. A bare command name never matches, a relative path never matches, and a path containing a space can never match at all: the token is truncated at the space, so no allowlist entry can ever equal it. Install somewhere without spaces in the path.
- **The allowlist is read once at module load.** Editing `harperdb-config.yaml` while Harper is running changes nothing. Restart Harper for a new entry to take effect.

The paths carry no version number, so they do not change when you upgrade the package.

### Singleton behaviour under Harper

Harper dedupes spawns with an exclusive PID-file lock: it opens `<rootPath>/pids/<name>.pid` with `wx`, so the first caller to get there wins and everyone else gets `EEXIST`. The lock is on the filesystem rather than in memory, which means it dedupes across worker threads **and** across processes.

Two distinct names (`datadog-agent` and `datadog-trace-agent`) take two independent locks, so one core agent and one trace-agent coexist while neither is ever started twice. Verified by execution against a real Harper 5.2.1: four worker threads produce one spawn and one PID file per name.

#### You only get this from component code, not from the shipped launchers

**Harper's spawn gate applies only to modules Harper's own loader evaluates, and only on the ESM path.** Two independent conditions have to hold, and the `datadog-agent` / `datadog-trace-agent` CLI launchers satisfy neither:

- Harper substitutes its constrained `child_process` when resolving **ESM** imports. Its CommonJS bridge forwards a builtin specifier straight to Node's real `require` without consulting the substitution table, so `require("child_process")` returns the unconstrained module. This package's `dist/` is CommonJS.
- A module reached through an npm package that Harper did not load through its own loader gets the real `child_process` regardless.

So when the launchers call `spawn(..., { name })`, stock Node **ignores** `name`: no PID lock is taken, no allowlist is consulted, and no `ExistingProcessWrapper` is ever returned. The launchers are CLI entry points. Running one per worker thread starts one agent per worker thread.

To actually get the singleton, the spawn must live in **your component's own module graph**, reached by a **relative ESM import** from your entry file:

```js
// resources.js  — Harper loads this, so its relative imports go through Harper's loader
import { startDatadogAgents } from "./dd-supervisor.js";

// dd-supervisor.js
import { spawn } from "node:child_process"; // ESM import, NOT require()
```

`example/dd-supervisor.js` in this repo is a working implementation, including a startup self-check that proves interception is live and fails loudly if it is not. Copy that pattern rather than shelling out to the launchers.

Two consequences for that component code:

- **The loser of the race does not get a `ChildProcess`.** It gets a handle carrying `pid`, `kill()`, `unref()`, and an `'exit'` event, and nothing else. There is no `stdout`, `stderr`, or `stdin`, so `child.stdout.on(...)` written without a guard throws a `TypeError` on every thread except the winner. That handle also runs a 1 Hz liveness interval that is not unref'd, so a thread that joined an existing process never goes idle until it calls `child.unref()` itself.
- **`version` is how you force a replacement, and it must be a number.** If it differs from the value recorded in the PID file, Harper kills the running process and spawns a new one. Harper parses the recorded value with `parseInt`, so a **string** version never compares equal to itself: every thread would decide the running agent is stale, SIGTERM it, and respawn, forever. Pass a number.

### Install scripts

Harper v5 installs packages with `--ignore-scripts` by default. This package and its platform sub-packages **do not** rely on install scripts — the right binary is selected through `optionalDependencies`. You do **not** need `applications.allowInstallScripts: true`.

### Build-time tooling is not for the runtime

`DatadogAgentBuilder` (the source-build path that shells out to `dda`, `go`, `pip`, etc.) is for a developer shell or CI runner, not for use inside a Harper-managed process. The supported runtime entry points are `BinaryManager.ensureBinary()` / `ensureTraceAgentBinary()` plus the two launchers.

## Troubleshooting: no traces in Datadog

Spans are dropped quietly at every stage, so work down this list in order. The first check that fails is the answer.

| Check | How | If it fails |
|---|---|---|
| Is the trace-agent process running? | `pgrep -fl trace-agent` | Nothing is receiving spans. Start `datadog-trace-agent run -c <config>`, and check the launcher output for a preflight failure (missing `datadog.yaml`, unwritable config dir) or a rejected spawn. |
| Is the receiver answering? | `curl -s http://127.0.0.1:8126/info` | The process is up but not serving on that port. Compare `DD_APM_RECEIVER_PORT` with the `DD_TRACE_AGENT_URL` the tracer uses, and confirm `DD_APM_ENABLED` is not `false`. A healthy response lists `/v0.4/traces` in its endpoints. |
| Is the trace-agent receiving anything? | Look for `traces received: N` in its own log output | `N` staying 0 means the tracer is not sending. Confirm `dd-trace` is actually loaded in the application process, not just installed. |
| Is `DD_API_KEY` set in the trace-agent's environment? | The launcher prints `DD_API_KEY=set` or `MISSING` at startup | Without it the receiver still accepts spans and the intake discards them. The application sees successful flushes and Datadog shows nothing. |
| Is the trace-agent path allowlisted? | Compare `applications.allowedSpawnCommands` against the path `ensureTraceAgentBinary()` prints | The spawn was rejected. Add the exact absolute path, then restart Harper, since the allowlist is read once at module load. |

Under Harper, `dd-trace` also has to be loaded into the worker threads. `threads.preloadRequire: dd-trace/init` is what initializes the tracer; `threads.preload: dd-trace/register.js` is additionally needed for HTTP instrumentation. Measured: `dd-trace/register.js` under `--import` alone initializes nothing, so the preload-only configuration produces a running tracer-less process that looks correctly configured.

## Building from source (maintainers)

Most consumers never need this. It is how the published binaries are produced.

```bash
# Build for the current platform (both binaries)
datadog-agent-build build

# Pin a version and output directory
datadog-agent-build build --datadog-version 7.50.0 --output ~/my-datadog-agent-build

# Other commands
datadog-agent-build install     # (re)install the binaries for this platform
datadog-agent-build platforms   # list supported platforms
datadog-agent-build version     # latest upstream version
```

```typescript
import { DatadogAgentBuilder } from '@deliciousmonster/datadog-agent-binary';

const result = await new DatadogAgentBuilder().buildForCurrentPlatform({
  version: '7.50.0',
  outputDir: './build',
});
```

`BuildOptions`: `version?`, `outputDir?`, `sourceDir?`, `buildArgs?`. `BuildResult` carries `outputPaths` (every binary, keyed by kind) alongside the original `outputPath`, which still points at the core agent.

### Build targets

One build run produces both binaries. The builder iterates the platform's binary descriptors and runs one upstream task per binary:

| Binary | Task | Flags |
|---|---|---|
| Core agent | `dda --no-interactive inv agent.build` | `--build-exclude=systemd,python` |
| Trace-agent | `dda --no-interactive inv trace-agent.build` | none |

**The trace-agent takes no `--build-exclude` flags, and passing the core agent's would be wrong rather than merely redundant.** `TRACE_AGENT_TAGS` contains neither `python` nor `systemd`, and `tasks/trace_agent.py::build()` has no `embedded_path`, `rtloader_root`, or `exclude_rtloader` parameter. It is a plain `go_build` with no rtloader, no CPython, and no cmake, so there is nothing there for those excludes to act on.

Either binary's flags can be overridden for a run without a code change: `DD_AGENT_BUILD_ARGS` for the core agent, `DD_TRACE_AGENT_BUILD_ARGS` for the trace-agent.

Upstream writes the results to `<sourceDir>/bin/agent/agent` and `<sourceDir>/bin/trace-agent/trace-agent`; the builder copies them out as `datadog-agent` and `trace-agent`. A missing binary fails the build naming the expected path and the task that produces it, rather than packaging a partial result.

### Build requirements

Go (match the agent's `go.mod`, so 7.79.x needs Go 1.25.x), Node 18+, Python 3.12, CMake, Git, plus a C toolchain per platform: GCC (Linux), Xcode Command Line Tools (macOS), MinGW-w64 GCC (Windows).

Python appears twice here and the two uses are unrelated:

- **Build-time Python is required for both binaries.** `dda` is a Python CLI and Datadog's build system is invoke-based, so every `dda inv <task>` needs it. `trace-agent.build` is no exception: at 7.79.1 it runs `go generate -mod=<mode> <repo>/pkg/trace/info` before compiling (`tasks/trace_agent.py:59`). Building the trace-agent without Python means bypassing the invoke task and running the underlying `go build` directly.

  Install `dda` into a **virtualenv or via pipx**, not with a bare `pip install --user`. A user-site install resolves its data directory to the interpreter prefix while pip writes to `~/.local/share`, so every command then dies with `FileNotFoundError: .../share/dda-data/uv.lock`. On a PEP-668 Debian or Ubuntu image, `pip install dda` outside a venv fails outright with `externally-managed-environment`.
- **Python must not end up inside the core agent binary.** That is what `--build-exclude=systemd,python` prevents. The `python` build tag links librtloader and an embedded CPython by an rpath into the build tree, producing a binary that only runs on the build machine. The trace-agent has no such tag and needs no such exclusion.

CMake is genuinely core-agent-only: it builds rtloader, which the trace-agent does not link. The trace-agent's compile step is a plain `go build` of `./cmd/trace-agent` with the `TRACE_AGENT_TAGS` set.

Both binaries are dynamically linked against glibc on Linux. The trace-agent's tag set includes `netcgo`, so it is not a static binary either; the glibc floor applies to it exactly as it does to the core agent, and CI checks both.

## How it works

1. **Pre-built binaries via optional dependencies.** The main package is platform-agnostic and declares one `optionalDependency` per platform. Each platform package contains both pre-built binaries under `bin/` and is tagged with npm `os`/`cpu`, so `npm install` pulls only the matching one. It exports one accessor per binary (`getBinaryPath()`, `getTraceAgentBinaryPath()`) plus a `binaries` map of kind to filename. At runtime `BinaryManager` resolves through those accessors, falling back to a locally built binary for the source-build workflow.
2. **Descriptor-driven pipeline.** Building, packaging, and runtime resolution all iterate one list of binary descriptors rather than each assuming a single binary. Adding a further sub-agent is a new entry in that list, not a change at five call sites. This is what makes "the trace-agent was never built, copied, packaged, resolved, or spawned" structurally hard to repeat.
3. **Release process.** GitHub Actions builds both binaries for all platforms from Datadog source, smoke-tests that each runs standalone, verifies the trace-agent's receiver actually accepts a trace payload on 8126, publishes each platform as its own npm package, and publishes the main package referencing them as optional dependencies. A platform whose build is missing either binary is skipped rather than published half-empty. Standalone archives are also attached to the GitHub Release.

## Development

```bash
npm install         # dependencies
npm run build       # compile TypeScript
npm run typecheck   # type-check only
npm run build-agent # build both agent binaries for the current platform
npm test            # run the tests
```

## License

Apache License 2.0.

The binaries this package downloads, builds, and distributes are licensed under the Apache License 2.0 as specified in the [Datadog Agent repository](https://github.com/DataDog/datadog-agent). The datadog-agent source code is copyrighted by Datadog, Inc.
