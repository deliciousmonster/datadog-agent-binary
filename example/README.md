# Harper v5 + Datadog: logs and traces from one component

A runnable Harper v5 application that starts the Datadog **core agent** and the Datadog
**trace-agent** as one-process-per-node singletons, emits application logs into `hdb.log`,
and produces APM traces from a REST endpoint.

Two processes, not one. The core agent handles metrics, checks, and log forwarding. The
trace-agent is a separate binary that binds `127.0.0.1:8126` and receives spans from
`dd-trace`. Without it running, `dd-trace` connects to a closed port and drops every span
without an error on either side, which is why this example checks for it explicitly rather
than assuming it.

## Requirements

| | Version | Why |
|---|---|---|
| Harper | >= 5.2 | `threads.preload` / `threads.preloadRequire` |
| Node | `^22.18 \|\| >=24` | Harper 5.2's own `engines.node`; `dd-trace` 6 requires >= 22 |
| `@deliciousmonster/datadog-agent-binary` | a build that ships `trace-agent` | Earlier releases packaged the core agent only |

Confirm the package you install actually contains the trace-agent before anything else. If
this prints nothing, no amount of configuration downstream will produce a trace:

```bash
node -e "const {BinaryManager}=require('@deliciousmonster/datadog-agent-binary'); \
  new BinaryManager().ensureTraceAgentBinary().then(console.log)"
```

## Files

| File | Role |
|---|---|
| `resources.js` | Component entry. REST resources that log and trace. |
| `dd-supervisor.js` | Starts both agents. Reached by a **relative** import, which is what makes the singleton real. |
| `config.yaml` | Component config: `rest` + `jsResource`. |
| `harper-config.yaml` | Keys to merge into the node's `harperdb-config.yaml`. |
| `conf.d/harperdb.d/conf.yaml` | Datadog log source template for `hdb.log`. |

## Run it

### 1. Install

```bash
cd example
npm install
```

If you are testing an unreleased build of the agent package (which you are, until the
trace-agent ships in a release), install it from the checkout instead:

```bash
cd ..            # repo root
npm pack         # -> harperfast-datadog-agent-binary-<version>.tgz
node scripts/create-platform-packages.js
cd npm/<your-platform> && npm pack --pack-destination ../..
cd ../../example
npm install --no-save ../harperfast-datadog-agent-binary-*.tgz ../harperfast-datadog-agent-binary-*-*.tgz
```

### 2. Print the two binary paths

Harper's spawn allowlist is an exact absolute-path match, so both paths have to be verbatim.

```bash
node -e "const {BinaryManager}=require('@deliciousmonster/datadog-agent-binary'); \
  const m=new BinaryManager(); \
  m.ensureBinary('core').then(p=>console.log('core :',p)); \
  m.ensureTraceAgentBinary().then(p=>console.log('trace:',p));"
```

```
core : /path/to/example/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
trace: /path/to/example/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

Neither path may contain a space. Harper matches the allowlist with
`command.split(" ")[0]`, so only the fragment before the first space is ever compared and a
path with a space in it can never be allowlisted, by any configuration.

### 3. Configure the node

Merge the blocks from `harper-config.yaml` into `<ROOTPATH>/harperdb-config.yaml`,
substituting the two paths from step 2. Merge, do not replace: Harper reads the config file
it finds and does not fall back to `defaultConfig.yaml` for keys a hand-written file omits.

The three things that must be right:

```yaml
applications:
  allowedSpawnCommands:
    - npm                  # Harper's own defaults; your list replaces them, not extends
    - node
    - <core path from step 2>
    - <trace path from step 2>

threads:
  preloadRequire: dd-trace/init          # starts the tracer
  preload: dd-trace/register.js          # ESM loader hooks for http instrumentation

logging:
  file: true
  path: /abs/path/to/harper/log/hdb.log  # must match DD_HARPER_LOG_PATH below
  level: info                            # else the agents' startup lines are dropped
```

**Both `threads` entries are required and neither substitutes for the other.** Measured, on
`dd-trace` 6.10.0, by running the same endpoint three ways against a receiver on 8126:

| Worker flags | `tracerInitialized` | Spans received |
|---|---|---|
| neither | `false` | none |
| `--import dd-trace/register.js` only | `false` | none |
| `--require dd-trace/init` | `true` | all four |

`register.js` installs loader hooks; it never calls `init()`. Note what the failing rows do
*not* do: they do not throw, and `GET /Work/` still returns a plausible trace id, because an
uninitialised `dd-trace` hands out `NoopSpan`s with real-looking ids. The `tracerInitialized`
field in the response is the only reliable signal.

Restart Harper after editing. The allowlist is captured once at module load
(`const ALLOWED_COMMANDS = new Set(...)`), so an edit without a restart changes nothing and
looks exactly like the edit being ignored.

### 4. Set the environment

```bash
export DD_API_KEY=<your key>          # omit to run without an account, see below
export DD_SITE=datadoghq.com
export DD_ENV=development
export DD_SERVICE=harper-example      # must match `service` on the log source
export DD_HARPER_LOG_PATH=/abs/path/to/harper/log/hdb.log
# Optional. Defaults to <ROOTPATH>/datadog, or ~/.harper-datadog when ROOTPATH is unset.
export DD_HARPER_RUNTIME_DIR=/abs/path/to/harper/datadog
```

`DD_API_KEY` is read from the environment and deliberately never written into the generated
`datadog.yaml`.

### 5. Start Harper

```bash
harper run .
```

Expected in `hdb.log`, in this order:

```
Datadog supervisor: Harper's constrained child_process is active (probe rejected with
  "Command harper-datadog-spawn-probe-must-not-exist is not allowed"). Agent spawns are
  deduped by the PID-file lock under <rootPath>/pids/, so this node runs exactly one core
  agent and one trace-agent no matter how many worker threads load this component.
Datadog supervisor: started the trace-agent (pid 1234): /.../bin/trace-agent run -c /.../datadog/datadog.yaml
Datadog supervisor: started the core agent (pid 1235): /.../bin/datadog-agent run -c /.../datadog
```

The other worker threads print this instead, and that is the correct outcome:

```
Datadog supervisor: the trace-agent is already running on this node (pid 1234); this thread
  joined it instead of starting a second one.
```

The first line is the one to check. If it says
`HARPER'S SPAWN INTERCEPTION IS NOT ACTIVE`, stop: there is no singleton, every worker thread
will start its own pair of agents, and all but one trace-agent will die on `EADDRINUSE`
without saying so. See [How the singleton works](#how-the-singleton-works).

### 6. Call the endpoint

```bash
curl -s -u HDB_ADMIN:password http://localhost:9926/Work/ | jq
```

```json
{
  "traceId": "2781589894077570770",
  "traceId128": "6a7e0ff200000000269a31456b4f5ed2",
  "tracerInitialized": true,
  "service": "harper-example",
  "sum": 21171191,
  "delayMs": 25,
  "hint": "Search Datadog APM for trace_id:2781589894077570770"
}
```

`tracerInitialized: true` is the assertion that matters. If it is `false`, the trace id in
that same response is a `NoopSpan`'s and nothing was sent; go back to step 3.

The request produces a three-span trace (`harper.work.request`, with `harper.work.compute`
and `harper.work.io` beneath it) and two log entries: an `info` line, and a `warn` carrying
an `Error` whose stack runs to three physical lines. That second one is deliberate. It is
what exercises the `multi_line` rule in `conf.d/harperdb.d/conf.yaml`; without that rule each
`at ...` frame arrives in Datadog as its own log entry.

## Verifying without a Datadog account

Everything up to the Datadog intake can be checked locally. The trace-agent accepts spans
whether or not the API key is valid, so all of this works with `DD_API_KEY` unset.

**The receiver is listening and serving the traces endpoint:**

```bash
curl -s 127.0.0.1:8126/info | jq -e '.endpoints | index("/v0.4/traces")'
```

A number means the receiver is up and advertising the endpoint `dd-trace` posts to.
A connection refused means the trace-agent is not running. Check `hdb.log` for the
supervisor's startup lines, and `<runtime dir>/logs/trace-agent.log`.

**Spans are actually arriving.** Call `/Work/` a few times, then look for the trace-agent's
periodic summary in `hdb.log` (the supervisor forwards agent output there) or in
`<runtime dir>/logs/trace-agent.log`:

```
[TRACE] ... INFO (...): [lang:nodejs ...] -> traces received: 4, traces filtered: 0,
        traces amount: 1234 bytes, events extracted: 0, events sampled: 0
```

`traces received` climbing as you curl is the end-to-end proof: `dd-trace` in the Harper
worker reached the trace-agent over 8126.

**Exactly one of each process:**

```bash
ls <ROOTPATH>/pids/
# datadog-agent.pid  datadog-trace-agent.pid
pgrep -f 'bin/(datadog-agent|trace-agent)' | wc -l   # 2, regardless of thread count
```

**The status endpoint** reports the whole picture, including whether spawn interception is
live:

```bash
curl -s -u HDB_ADMIN:password http://localhost:9926/DatadogStatus/ | jq
```

## Verifying with a Datadog account

With `DD_API_KEY` and `DD_SITE` set:

- **APM**: paste the `traceId` from the response into APM > Traces as `trace_id:<value>`, or
  filter by `service:harper-example`. You should see `harper.work.request` with two child
  spans.
- **Logs**: Logs > Search for `service:harper-example`. The `warn` entry should arrive as
  **one** log whose message contains the whole stack trace. If you instead see one entry per
  `at ...` line, the `multi_line` rule is not reaching the agent: check that `confd_path` in
  the generated `datadog.yaml` points at the runtime `conf.d` and that
  `<runtime dir>/conf.d/harperdb.d/conf.yaml` was written.
- **Correlation**: logs and traces line up only when the log source's `service` matches
  `DD_SERVICE`. Both are set from `DD_SERVICE` here for that reason.

A missing `DD_API_KEY` produces no error anywhere. The receiver accepts spans, batches them,
and discards them when the intake rejects the payload; `dd-trace` sees a successful flush
either way. The supervisor warns about this at startup, which is the only notice you get.

## How the singleton works

Harper does the deduplication. Component code never receives the real `node:child_process`:
`security/jsLoader.ts` substitutes a constrained module that applies three gates, in order.

1. **Allowlist.** `ALLOWED_COMMANDS.has(command.split(" ")[0])`, else
   `Command <x> is not allowed`.
2. **Mandatory name.** `spawn` without `options.name` throws.
3. **PID-file lock.** `openSync("<rootPath>/pids/<name>.pid", "wx")`. Whoever creates the
   file spawns; everyone else gets an `ExistingProcessWrapper` for the running PID.

Because the lock is a file rather than in-process state, it dedupes across worker threads
*and* across processes sharing a root path. That is "one per node", and it needs no leader
election. Two distinct `name` values give two independent locks, which is what lets the core
agent and the trace-agent each be a singleton without blocking the other.

Three consequences the supervisor has to handle, and does:

- **Losers get a stub.** `ExistingProcessWrapper` exposes `pid`, `kill()`, `unref()` and an
  `exit` event, and **no `stdout`/`stderr`/`stdin`**. Code that does `child.stdout.on(...)`
  throws a `TypeError` on every thread that lost the race. Its liveness poll is a 1 Hz
  `setInterval` that is never unref'd, so the thread must call `child.unref()` or its event
  loop stays pinned through shutdown.
- **`error` has no listener.** Harper registers only `exit`. An asynchronous spawn failure
  arrives as `error` and Node promotes an unhandled `error` on a `ChildProcess` to an
  uncaught exception, killing the worker. The supervisor attaches its own listener
  immediately after `spawn` returns, before any other branch.
- **`version` forces a replacement.** Harper compares `options.version` against line 2 of
  the PID file and, on a mismatch, SIGTERMs the running process and re-acquires the lock.
  The supervisor passes a hash of the resolved binary paths plus the generated config, so a
  changed binary or config replaces the agents instead of adopting one left over from a
  previous boot. It must be a **number**: Harper reads the recorded value with `parseInt()`
  and compares with `!==`, so a string version never equals its own recorded value and every
  thread would kill and respawn forever.

### Why the supervisor is imported relatively

`shouldUseApplicationLoader()` decides which modules get the constrained `child_process`:

```js
if (specifier.startsWith(".")) return true;              // relative -> always
...
if (resolvedUrl.includes("/node_modules/"))
    return packageDependsOnHarper(resolvedUrl);          // npm dep -> only if it needs Harper
return false;
```

Move `dd-supervisor.js` into an npm package that does not itself depend on `harper` and it is
loaded natively with the **real** `child_process`: no allowlist, no name requirement, and no
PID lock. It would start one core agent and one trace-agent per worker thread and look
entirely healthy while doing it.

The same applies to how the builtin is imported. Harper's CommonJS shim forwards anything
that is not a `file:` URL straight to the real `require` without consulting the substitution
table, so `require("node:child_process")` inside an app module returns the unconstrained
builtin. Only the ESM `import` path runs the check. Hence `import { spawn } from
"node:child_process"`, never `require`.

Because all of that is invisible when it goes wrong, `dd-supervisor.js` proves it at startup:
it tries to spawn a command that cannot exist and requires the attempt to be refused. Under
Harper that throws `Command ... is not allowed` synchronously, with no process and no PID
file created. Under real Node it does not throw at all. Anything other than a refusal is
logged as an error naming the three causes.

## Non-root paths

The deploy target runs as a non-root user (`USER harperdb` on `node:24-trixie`), where every
Datadog default location is unwritable: `/etc/datadog-agent`, `/opt/datadog-agent`,
`/var/log/datadog`, `/var/run/datadog`. The supervisor writes a `datadog.yaml` on every start
that relocates all of them under the runtime directory:

```yaml
confd_path:           <runtime>/conf.d
run_path:             <runtime>/run
auth_token_file_path: <runtime>/run/auth_token
ipc_cert_file_path:   <runtime>/run/ipc_cert.pem
disable_file_logging: true
log_file:             <runtime>/logs/agent.log
bind_host:            "127.0.0.1"
apm_config:
  enabled: true
  receiver_port: 8126
  apm_non_local_traffic: false
  log_file: <runtime>/logs/trace-agent.log
```

File logging is disabled *and* both log paths are relocated, so an agent that ignores
`disable_file_logging` still writes somewhere it is permitted to, rather than emitting a
permission-denied line per log line into Harper's own log.

The runtime directory is resolved as `DD_HARPER_RUNTIME_DIR`, else `<ROOTPATH>/datadog`, else
`~/.harper-datadog`. The component's own directory is deliberately not used: `harper deploy`
replaces it, which would delete the run directory out from under a live agent.

Two details the two binaries disagree on, both verified against the shipped binaries:

- the **core agent**'s `-c`/`--cfgpath` is the **directory** containing `datadog.yaml`;
- the **trace-agent**'s `-c`/`--config` is the **file** itself. Its help text claims
  "directory", but its compiled default is `/opt/datadog-agent/etc/datadog.yaml`.

The trace-agent also requires that config file to **exist** (contents are irrelevant, an
empty file works) and its directory to be **writable**, because it writes its auth token
there. Missing file means an immediate `unable to load Datadog config file`. Unwritable
directory means a 30-second hang and then a failure that reads like a network problem. The
supervisor creates both up front and checks writability before spawning.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `HARPER'S SPAWN INTERCEPTION IS NOT ACTIVE` | Supervisor not reached by a relative import, or `child_process` pulled in with `require()`, or `applications.moduleLoader: native`. |
| `Command /... is not allowed` | Path not in `allowedSpawnCommands`, or Harper not restarted after the edit, or the path contains a space. |
| `tracerInitialized: false` | `threads.preloadRequire: dd-trace/init` missing. `preload` alone does not initialise anything. |
| `curl 127.0.0.1:8126/info` refused | trace-agent not running. Check `hdb.log` and `<runtime>/logs/trace-agent.log`. |
| trace-agent exits immediately, non-zero | Something else holds 8126, or `datadog.yaml` is missing at the path passed to `-c`. |
| trace-agent hangs ~30s then dies on its auth token | Its config directory is not writable. |
| Stack traces arrive as one log per line | The `multi_line` rule is not reaching the agent. Check `confd_path` and the rendered `conf.d/harperdb.d/conf.yaml`. |
| Nothing in Datadog, no errors anywhere | `DD_API_KEY` unset or wrong. Spans and logs are accepted locally and dropped at the intake. |
| Agent startup lines absent from `hdb.log` | `logging.level` is `warn` (Harper's default). Set it to `info`. |
