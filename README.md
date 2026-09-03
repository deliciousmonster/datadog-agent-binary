# Datadog Agent Binary

[![Datadog Agent Binaries](https://github.com/HarperFast/datadog-agent-binary/actions/workflows/build-release.yml/badge.svg)](https://github.com/HarperFast/datadog-agent-binary/actions/workflows/build-release.yml)

Distributes the pre-compiled [Datadog Agent](https://github.com/DataDog/datadog-agent) as an npm package, so the agent can be installed and versioned as a normal Node dependency instead of through a system package manager or container sidecar. This is intended for running the agent alongside a Node application, including inside Harper v5.

The repo covers two things:

- **Runtime:** the installed agent binary for the current platform and a `datadog-agent` command to run it. This is what consumers depend on.
- **Build:** tooling to compile the agent from Datadog source for each supported platform, used to produce the published binaries. Most consumers don't need this.

## What it does

- Installs the agent binary for the current platform via `optionalDependencies`. The main package is platform-agnostic and declares one optional dependency per platform (e.g. `@harperfast/datadog-agent-binary-linux-x86_64`), each tagged with npm `os`/`cpu`, so `npm install` fetches only the matching one. No install scripts; no download at install time.
- Provides a `datadog-agent` command that resolves the installed binary and runs it, passing arguments and environment through to the agent.
- Passes the `name` option that Harper v5's spawn enforcement requires, so the agent can be launched from a Harper component. See [Harper v5 compatibility](#harper-v5-lincoln-compatibility).
- Logs binary resolution, the spawn (path, args, PID), exit status, and which Datadog environment variables are present — useful when diagnosing why no data reaches Datadog. The `DD_API_KEY` value is not logged, only whether it is set. See [Startup logging](#startup-logging).
- Builds the agent from source for Linux on x86_64 and arm64, Windows on x86_64, and macOS on arm64.

It does not configure Datadog. API key, site, and collection settings are provided the usual Datadog way — environment variables or `datadog.yaml`. See [Connecting to Datadog](#connecting-to-datadog).

## Installation

```bash
npm install @harperfast/datadog-agent-binary
```

Installing pulls in the pre-built agent binary for your platform automatically via `optionalDependencies` — only the package whose `os`/`cpu` match your machine is fetched.

## Usage

### Running the agent

```bash
datadog-agent run        # run the agent
datadog-agent status     # check status
datadog-agent version    # print version
```

All arguments and environment variables are passed straight through to the underlying Datadog Agent, so any agent subcommand works.

### Connecting to Datadog

This package ships the full agent; **configuring** it is independent of this package and done the standard Datadog way. The variables that matter most:

| Variable | Purpose | Notes |
|---|---|---|
| `DD_API_KEY` | Authenticates to Datadog | Without it the agent starts but **disables** its connection — nothing is sent. |
| `DD_SITE` | Destination site | e.g. `datadoghq.com`, `datadoghq.eu`. Defaults to `datadoghq.com`. |
| `DD_ENV` | `env` tag on all data | e.g. `production`, `development`. |
| `DD_LOGS_ENABLED` | Enables **log collection** | Defaults to `false` — logs only forward when set to `true`. Separate from the agent connecting at all. |
| `DD_LOG_TO_CONSOLE` | Agent's own logs to stdout | Defaults to `true`. |

See Datadog's [Agent environment variables](https://docs.datadoghq.com/agent/guide/environment-variables/) for the full list, or use a `datadog.yaml`.

### Startup logging

The `datadog-agent` launcher emits diagnostics at `info`/`warn` (visible without any debug flag) before and around the spawn:

- the detected platform/arch and the resolved binary path (or a warning if no platform package is installed);
- the spawn itself — binary path, args, child PID — and the exit code or terminating signal;
- which Datadog env vars are present: `DD_API_KEY` (reported only as `set`/`MISSING`, never the value), `DD_SITE`, `DD_ENV`, `DD_LOGS_ENABLED`, `DD_LOG_TO_CONSOLE`;
- a clear error naming the path to allowlist if Harper's spawn enforcement rejects the launch.

This makes the common failure modes ("agent disabling," "no logs flowing," "spawn blocked") diagnosable straight from the container logs.

### Programmatic usage

```typescript
import { BinaryManager } from '@harperfast/datadog-agent-binary';

// Resolve the platform binary installed via optionalDependencies.
const binaryPath = await new BinaryManager().ensureBinary();
console.log(`Datadog Agent at: ${binaryPath}`);
```

## Supported platforms

| OS | Architecture | Status |
|----|-------------|--------|
| Linux | x86_64 | ✅ |
| Linux | arm64 | ✅ |
| Windows | x86_64 | ✅ |
| Windows | arm64 | 🚫 |
| macOS | x86_64 | 🚫 |
| macOS | arm64 | ✅ |

Windows arm64 is blocked by [Chocolatey](https://chocolatey.org) not supporting arm64 natively.
macOS x86_64 is out because the release matrix has no runner for it; a target with no matrix leg
publishes an optional dependency npm skips in silence.

## Harper v5 (Lincoln) compatibility

Running the agent from inside a Harper v5 application has two requirements; this package handles one of them and the consuming app handles the other.

### Spawning the agent from a Harper component

Harper v5 only lets a component `spawn`/`exec` an executable that is (a) launched with a `name` option (so Harper can dedupe the child across worker threads) and (b) listed by its **exact absolute path** in `applications.allowedSpawnCommands`.

The `datadog-agent` launcher already passes `name: "datadog-agent"`, so all the consuming app must do is allowlist the resolved binary path. Resolve it the same way the launcher does:

```js
import { BinaryManager } from '@harperfast/datadog-agent-binary';
const binaryPath = await new BinaryManager().ensureBinary();
console.log(binaryPath);
// e.g. /app/node_modules/@harperfast/datadog-agent-binary-linux-x86_64/bin/datadog-agent
```

Then add that exact path to `harperdb-config.yaml`:

```yaml
applications:
  allowedSpawnCommands:
    - /app/node_modules/@harperfast/datadog-agent-binary-linux-x86_64/bin/datadog-agent
```

A bare command name will not match — the full absolute path is required. The path has no version number in it, so it does not change when you upgrade the package.

### Running it as a Harper component

The package is also a Harper component. Installed and named in the node's root config, it starts and
supervises both agents itself, renders their `datadog.yaml`, ships the core-check configuration that
host metrics need, and holds the launch open until the APM receiver actually answers.

Naming it in the root config is not optional. Harper hands a component a `Scope` only for one its root
`harper-config.yaml` names, and discards the module of a component it found by scanning
`componentsRoot`. A scanned copy loads, serves its resources, and supervises nothing.

```yaml
# The file settings_path names in ~/.harperdb/hdb_boot_properties.file. The key is the component
# directory's own name, because a root entry resolves to <componentsRoot>/<key>.
datadog-agent-binary: { package: "@harperfast/datadog-agent-binary" }
```

`DD_API_KEY` and `DD_SITE` are read from the environment and are deliberately never written to the
rendered `datadog.yaml`. `DD_APM_RECEIVER_PORT` and `DD_EXPVAR_PORT` move the two ports the component
pins and polls. `GET /DatadogStatus/` reports what startup did on the thread that answers it; verify
the agents themselves with `curl` from a shell rather than through that endpoint, which is inside the
traced request path it would be reporting on.

This needs a Harper build whose `Scope` carries the process sidecar API. Where it does not, the
component refuses to start rather than spawning one trace-agent per worker thread, and says so.

### Install scripts

Harper v5 installs packages with `--ignore-scripts` by default. This package and its platform sub-packages **do not** rely on install scripts — the right binary is selected through `optionalDependencies`. You do **not** need `applications.allowInstallScripts: true`.

### Build-time tooling is not for the runtime

`datadog-agent-build` (the source-build path that shells out to `dda`, `go`, `pip`, etc.) is for a developer shell or CI runner, not for use inside a Harper-managed process. The supported runtime entry point is `BinaryManager.ensureBinary()` plus the `datadog-agent` launcher.

## Building from source (maintainers)

Most consumers never need this — it's how the published binaries are produced.

```bash
# Build for the current platform
datadog-agent-build build

# Pin a version and output directory
datadog-agent-build build --datadog-version 7.50.0 --output ~/my-datadog-agent-build

# Other commands
datadog-agent-build install     # (re)install the binary for this platform
datadog-agent-build platforms   # list supported platforms
datadog-agent-build version     # latest upstream version
```

### Build requirements

Go 1.23, Node 18+, Python 3.12, CMake, Git, plus a C toolchain per platform: GCC (Linux), Xcode Command Line Tools (macOS), MinGW-w64 GCC (Windows).

## How it works

1. **Pre-built binaries via optional dependencies.** The main package is platform-agnostic and declares one `optionalDependency` per platform. Each contains the pre-built agent and is tagged with npm `os`/`cpu`, so `npm install` pulls only the matching one. At runtime `BinaryManager.ensureBinary()` resolves the binary from that installed package (falling back to a locally built binary for the source-build workflow).
2. **Release process.** GitHub Actions builds the agent for all platforms from Datadog source, smoke-tests that each binary runs standalone, publishes each as its own npm package, and publishes the main package referencing them as optional dependencies. Standalone archives are also attached to the GitHub Release.

## Development

```bash
npm install         # dependencies
npm run build       # compile TypeScript
npm run typecheck   # type-check only
npm run build-agent # build the agent for the current platform
npm test            # run the tests
```

## License

Apache License 2.0.

The binaries this package downloads, builds, and distributes are licensed under the Apache License 2.0 as specified in the [Datadog Agent repository](https://github.com/DataDog/datadog-agent). The datadog-agent source code is copyrighted by Datadog, Inc.
