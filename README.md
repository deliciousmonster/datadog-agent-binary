# @deliciousmonster/datadog-agent-binary

[![Test](https://github.com/deliciousmonster/datadog-agent-binary/actions/workflows/test.yml/badge.svg)](https://github.com/deliciousmonster/datadog-agent-binary/actions/workflows/test.yml)

A Harper v5 plugin that runs the Datadog agents beside a node, so host metrics and the spans your application's `dd-trace` produces reach Datadog. The agents ship as prebuilt binaries, one npm package per platform; npm installs the one matching the host, and no install script runs.

Five binaries ship. The core agent and the trace-agent start on every node. system-probe, process-agent and security-agent are opt-in, in a package installed by name.

## What it does

Every worker thread Harper starts evaluates the plugin. Each one renders `datadog.yaml` from the environment, takes a pid lock per agent so the node runs one agent pair rather than one per thread, spawns both agents, verifies each answers as the process this node started, and keeps them up. Where Harper supervises processes natively it does the supervising; elsewhere the bundled [process guard](https://github.com/deliciousmonster/harper-process-guard) does, with a detached reaper that stops the agents when the node is killed rather than stopped.

## Install

```sh
npm install @deliciousmonster/datadog-agent-binary
```

Two entries in the node's `harper-config.yaml` decide whether anything starts. Name the component, keyed by its directory name:

```yaml
datadog-agent-binary: { package: "@deliciousmonster/datadog-agent-binary" }
```

Allow both binaries by absolute path, and keep `node`, which the reaper is spawned as:

```yaml
applications:
  allowedSpawnCommands:
    - node
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

`ls -d "$PWD"/node_modules/@deliciousmonster/datadog-agent-binary-*/bin/*` prints the paths for the host. On Windows both end in `.exe`. A bare command name matches neither.

## Use

Configuration is the environment; `datadog.yaml` is rewritten on every start, so editing it changes nothing.

| Variable | Effect |
| --- | --- |
| `DD_API_KEY` | Required. Without it the trace-agent exits at once and the intake refuses the core agent's payloads. |
| `DD_SITE` | Destination site. Datadog's default is `datadoghq.com`. |
| `DD_ENV` | The `env` tag on everything sent. |
| `DD_APM_RECEIVER_PORT` | Where `dd-trace` posts spans. Default 8126. |
| `DD_EXPVAR_PORT`, `DD_APM_DEBUG_PORT` | The agents' expvar ports, 5000 and 5012. Verification reads them; `0` turns one off and verification refuses. |
| `DD_LOGS_ENABLED` | `true` ships Harper's own log, `<rootPath>/log/hdb.log`, as service `harper`. Off by default. |

`GET /DatadogStatus/`, under Harper's own auth, reports which supervision is in charge, whether the API key is set, whether each agent verified and why not, and how far a span got: `delivery.verdict` is `delivering`, `rejected`, `traces-unrefuted`, `traces-unconfirmed`, `not-delivering` or `idle`. Its counters are the trace-agent's own one-minute window, so read it twice.

The plugin also publishes `system.processes.*` for the processes it spawned and for Harper itself, which is the namespace the Python `process` check owns and this build has no Python to run. `DD_HARPER_PROCESS_METRICS_ENABLED=false` turns it off, `DD_HARPER_PROCESS_METRICS_PREFIX` moves it somewhere private, and a live `conf.d/process.d/conf.yaml` makes it stand down on its own.

Everything the plugin writes sits under `<rootPath>/datadog/datadog-agent-binary/`: `datadog.yaml`, `conf.d/`, the agents' logs in `logs/`, and the locks in `pids/`. A lock a killed node left behind is safe to delete.

## Platforms

Linux x86_64 and arm64, macOS arm64, Windows x86_64. Windows arm64 waits on Chocolatey; macOS x86_64 has no GitHub runner left to build on.

## Opt-in: system-probe and security-agent

Neither runs unless asked for, and their binaries are in a package npm does not install on its own. They are
privileged and inert until a host is configured for them, so charging every install 145 MB for them is the
cost the split refuses.

```sh
npm install @deliciousmonster/datadog-agent-binary @deliciousmonster/datadog-agent-binary-probe-linux-x86_64
```

Then `DD_SYSTEM_PROBE_ENABLED=true`, and `DD_RUNTIME_SECURITY_CONFIG_ENABLED=true` for the security agent.
`DD_NETWORK_CONFIG_ENABLED` and `DD_SERVICE_MONITORING_CONFIG_ENABLED` turn on NPM and USM separately,
because one watches every connection on the host and the other parses their traffic. What a node needs
before system-probe can load a single program is four things it mostly cannot fix itself; `AGENTS.md` lists
them, and `GET /DatadogStatus/` reports which one is missing under `probes.blockers` rather than restarting
a process that exits every time.

## To do

- Native supervision through Harper's `scope.processes` is proven against a Harper branch, not a release.
- The Windows leg proves the binaries bind and serve, not the supervision equivalence property. `AGENTS.md` has the reason.
- `latest` on npm names a prerelease until 7.82.1 ships; install `@next` meanwhile.

## License

Apache-2.0. The agent binaries are Datadog's, Apache-2.0, built from the pinned release of [datadog-agent](https://github.com/DataDog/datadog-agent).
