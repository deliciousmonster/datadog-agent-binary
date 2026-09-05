# @harperfast/datadog-agent-binary

[![Datadog Agent Binaries](https://github.com/HarperFast/datadog-agent-binary/actions/workflows/build-release.yml/badge.svg)](https://github.com/HarperFast/datadog-agent-binary/actions/workflows/build-release.yml)

A Harper v5 plugin that runs the Datadog core agent and trace-agent alongside a node, so host metrics and the spans the host application's own `dd-trace` produces reach Datadog. `dd-trace` itself is the application's, not shipped here. Both agents arrive as pre-compiled binaries, one npm package per platform, picked by `optionalDependencies`; nothing is downloaded at install time and no install script runs.

The binaries are how the plugin does its job, not a product of their own. Running them outside a Harper node is not a surface this package supports.

## Install

```bash
npm install @harperfast/datadog-agent-binary
```

npm fetches only the platform package whose `os`/`cpu` match the host, so one agent pair arrives with the install. Two things in the node's own config then decide whether either agent starts.

### Name it in the root config

Harper hands a component a `Scope`, and so calls this plugin at all, only for one the node's root `harper-config.yaml` names. A directory it found by scanning `componentsRoot` loads, serves its resources and supervises nothing. The file is the one `settings_path` names in `~/.harperdb/hdb_boot_properties.file`, and the key is the component directory's own name, because a root entry resolves to `<componentsRoot>/<key>`:

```yaml
datadog-agent-binary: { package: "@harperfast/datadog-agent-binary" }
```

Sixty seconds after the module loads with no plugin call, the component logs the entry it needs and the reason nothing started.

### Allowlist both binaries

Harper only lets a component spawn an executable listed by its exact absolute path in `applications.allowedSpawnCommands`. The other half of that gate, a `name` option on every spawn, the plugin passes itself. Two binaries launch here, not one:

```sh
ls -d "$PWD"/node_modules/@harperfast/datadog-agent-binary-*/bin/*
```

```yaml
applications:
  allowedSpawnCommands:
    - node
    - /app/node_modules/@harperfast/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@harperfast/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

A bare command name matches neither one. The paths carry no version, so an upgrade leaves them where they are; on Windows both end `.exe`. Keep `node` in the list too: where Harper does not supervise natively, the bundled guard spawns its reaper as `process.execPath` and then as a bare `node`, and a reaper that cannot start leaves the agents running after the node stops.

Harper installs with `--ignore-scripts`, which costs this package nothing. `applications.allowInstallScripts` can stay off.

## Configure

The plugin does not configure Datadog. What follows is read from the environment, and `datadog.yaml` is rendered fresh on every worker start, so editing that file changes nothing.

| Variable | Effect |
| --- | --- |
| `DD_API_KEY` | Measured on 7.82.1: without it the core agent starts and collects while the intake refuses every payload with a 403, and the trace-agent exits at once with "you must specify an API Key", binding no receiver. |
| `DD_SITE` | Destination site, e.g. `datadoghq.eu`. Datadog's own default is `datadoghq.com`. |
| `DD_ENV` | The `env` tag on everything sent. |
| `DD_APM_RECEIVER_PORT` | Where `dd-trace` posts spans. Default 8126. |
| `DD_EXPVAR_PORT` | The core agent's expvar. Default 5000. |
| `DD_APM_DEBUG_PORT` | The trace-agent's own expvar. Default 5012. |

`DD_API_KEY` and `DD_SITE` are never written to disk; both agents read them from the inherited environment. Those two and `DD_ENV` are also part of the fingerprint each agent's PID lock carries, so changing one makes the next worker start take the lock and SIGTERM the agent still running under the old value.

Setting a port to `0` turns that endpoint off, and each one is load-bearing. Without the receiver `dd-trace` drops every span; without either expvar nothing can show that the process holding the port is the one this node started, and startup verification refuses rather than reporting healthy.

## Diagnose

Everything the plugin writes lands under `<rootPath>/datadog/<component directory>/`, with `rootPath` read from the node's own config chain, or from `ROOTPATH` where that is absolute. When no root resolves it falls back to `~/.harper-datadog/<component directory>/`. Under either root:

| Path | What it holds |
| --- | --- |
| `datadog.yaml` | The config both agents read. |
| `conf.d/` | The core checks this platform gets. Without them the core agent runs, reports healthy and collects no host metrics. |
| `logs/agent.log`, `logs/trace-agent.log` | The agents' own logs. `log_to_console` is off, so none of this reaches the container's stdout. |
| `logs/reaper.log` | The guard's reaper, where Harper is not supervising natively. |
| `pids/` | One lock per agent, which is what holds a node to one agent pair rather than one trace-agent per worker thread. Clear it when a killed node leaves a stale lock behind. |

The directory is named for the component, not just `datadog`: two installed copies sharing one `pids/` would share one lock.

`GET /DatadogStatus/` is the plugin's one resource and takes Harper's own auth. It re-reads process state and the trace-agent's delivery counters on each request rather than replaying what boot found. Read in this order:

- `supervision` is `harper` when the node's `Scope` carries the process sidecar API, `guard` when the bundled guard is holding the agents up instead.
- `apiKey` is `set` or `MISSING`, never the value.
- `processes[].verified` is a verdict on identity, not on liveness. The trace-agent's is taken by reading its expvar off the debug port and comparing the pid published there against the pid this node spawned, so something else holding the receiver port fails it rather than passing as healthy. `verifyDetail` names the case.
- `delivery.verdict` is how far a span got. `delivering` and `rejected` are evidence either way; `traces-unconfirmed` means the stats hop landed and the trace hop is unproven. Every counter behind it is a one-minute window the agent resets, so read it twice before believing it.

The agents answer directly too, which is the check that does not depend on the plugin:

```sh
curl -s  http://127.0.0.1:8126/info        # the APM receiver, at DD_APM_RECEIVER_PORT
curl -s  http://127.0.0.1:5000/debug/vars  # the core agent's expvar, at DD_EXPVAR_PORT
curl -sk https://127.0.0.1:5012/debug/vars # the trace-agent's expvar, at DD_APM_DEBUG_PORT
```

The last takes `-k` because the trace-agent serves its debug port under the self-signed IPC certificate it writes into `run/`.

## Supported platforms

| OS | Architecture | Status |
| --- | --- | --- |
| Linux | x86_64 | yes |
| Linux | arm64 | yes |
| Windows | x86_64 | yes |
| Windows | arm64 | no |
| macOS | x86_64 | no |
| macOS | arm64 | yes |

Windows arm64 waits on [Chocolatey](https://chocolatey.org) supporting arm64 natively. macOS x86_64 is out because GitHub retired the Intel runner, and a target with no leg in the release matrix publishes an optional dependency npm skips in silence.

## Building from source (maintainers)

This is how the published binaries are made; consumers do not need it. The build CLI is not in the published tarball, so it runs from a checkout, and it shells out to `dda`, `go` and `pip`, which belong in a developer shell or a CI runner rather than inside a Harper-managed process.

```bash
npm run build-agent               # current platform, at the version .datadog-agent-version pins
node dist/src/cli.js platforms    # supported platforms
node dist/src/cli.js version      # latest upstream version

# a version other than the pin
npm run build && node dist/src/cli.js build --datadog-version 7.50.0
```

Requires Go 1.23, Python 3.12, CMake, Git, a C toolchain, and the Node in `engines` (22.18+ or 24+).

Output goes to `build/<platform>/` under the directory you run from: `src/` is the clone, `go/` the GOPATH it is symlinked into, `bin/` the built binaries. No flag moves it, because `scripts/create-platform-packages.js` reads the binaries back out of that path.

Publishing is gated on the packed tarball rather than the working tree: `guard/` populated, both binaries present in every platform package, each carrying its required symbol and free of the Go build tag `--build-exclude` is there to drop.

```bash
npm test                 # component and e2e tiers
npm run typecheck
npm run test:binaries    # needs real binaries from a prior build-agent
npm run test:live        # boots a real node; released Harper is pinned at 5.2.9, and the
                         # native-supervision row needs DD_LIVE_HARPER_NATIVE set to a
                         # Harper worktree whose Scope carries scope.processes
```

## License

Apache License 2.0. The agent binaries built and distributed here are Apache 2.0 as specified in the [Datadog Agent repository](https://github.com/DataDog/datadog-agent), and the datadog-agent source is copyright Datadog, Inc.
