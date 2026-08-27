# Harper v5 + Datadog: logs and traces from one component

A runnable Harper v5 application that starts the Datadog core agent and the trace-agent as
one-process-per-node singletons, writes application logs into `hdb.log`, and produces APM
traces from a REST endpoint.

Two processes, not one. The core agent handles metrics, checks, and log forwarding; the
trace-agent is a separate binary that binds `127.0.0.1:8126` and receives spans from
`dd-trace`. Without it, `dd-trace` connects to a closed port and drops every span with no
error on either side, so this example checks for it explicitly.

## Requirements

| | Version | Why |
| --- | --- | --- |
| Harper | `>= 5.1.18` | `threads.preload` / `threads.preloadRequire` |
| Node | `^22.18 \|\| >=24` | Harper 5.2's `engines.node`; `dd-trace` 6 needs >= 22 |
| `@deliciousmonster/datadog-agent-binary` | a build that ships `trace-agent` | Earlier releases packaged the core agent only |

**Check your Harper version first; below the floor this fails silently.** `preloadRequire`
landed in the 5.1 line at **5.1.18** (5.1.17 has no reference to it anywhere in `dist/`) and
is in every 5.2. An older Harper does not reject the unknown config key — it ignores it, the
tracer is never initialised, and `GET /Work/` still returns a real-looking `traceId` from a
`NoopSpan`. The only signal is `tracerInitialized: false` in the response.

```bash
node -e "console.log(require('harper/package.json').version)"   # or: harper --version
```

Verified end to end on **5.1.22** and **5.2.2**: identical results on both — spawn
interception active, one core agent and one trace-agent, `tracerInitialized: true`, spans
reaching the intake, DogStatsD samples aggregating, and `hdb.log` tailed. The example needs
no version-specific code.

## Files

| File | Role |
| --- | --- |
| `resources.js` | Component entry. REST resources that log and trace. |
| `dd-supervisor.js` | Starts both agents. Reached by a **relative** import, which is what makes the singleton real. |
| `dd-reaper.js` | Stops both agents when the node stops. Its own process, because Harper gives a component no shutdown hook. |
| `config.yaml` | Component config: `rest` + `jsResource`. |
| `harper-config.example.yaml` | Keys to merge into the node's `harper-config.yaml`. |
| `conf.d/harperdb.d/conf.yaml` | Datadog log source template for `hdb.log`. |

The host-check configurations are not here. They carry no component-specific value, so they ship
in the package's own `conf.d/` and the supervisor copies them into the runtime tree from there.

## 1. Install

`package.json` depends on the parent checkout (`file:..`), so:

```bash
cd example
npm install
```

That gets you the main package. The binaries themselves come from a platform sub-package,
which until the release is published you build and install yourself:

```bash
cd ..                                        # repo root
npm run platform-package                     # builds the agents, writes npm/<platform>/
cd npm/<your-platform> && npm pack --pack-destination ../..
cd ..
npm install --no-save ./deliciousmonster-datadog-agent-binary-*-*.tgz   # repo root, not example/
```

**Install that tarball at the repo root, not inside `example/`.** `file:..` makes
`example/node_modules/@deliciousmonster/datadog-agent-binary` a symlink to the repo root,
and Node resolves bare specifiers from the importing module's realpath — so
`binary-manager.js` looks for the platform package in the *repo root's* `node_modules`.
Install it under `example/` and it is never consulted: resolution silently falls through
to the build-from-source path and uses `build/<platform>/bin/` instead. That still runs,
which is the problem — it looks like the packaged install works when it has not been
exercised at all.

Confirm the trace-agent is actually there before anything downstream, and read the line
above the path, not just the path:

```bash
node -e "const {BinaryManager}=require('@deliciousmonster/datadog-agent-binary'); \
  new BinaryManager().ensureTraceAgentBinary().then(console.log)"
```

`Using packaged Datadog trace agent binary: …/node_modules/@deliciousmonster/…` is the
result you want. `falling back to the build-from-source lookup` means the platform package
is not resolvable and you are testing something other than what ships.

## 2. Print the two binary paths

The allowlist is an exact absolute-path match, so both paths have to be verbatim.

```bash
node -e "const {BinaryManager}=require('@deliciousmonster/datadog-agent-binary'); \
  const m=new BinaryManager(); \
  m.ensureBinary('core').then(p=>console.log('core :',p)); \
  m.ensureTraceAgentBinary().then(p=>console.log('trace:',p));"
```

```
core : /path/to/repo/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
trace: /path/to/repo/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent
```

Under this `file:..` layout the paths sit in the **repo root's** `node_modules`, not
`example/`'s, for the resolution reason in step 1. In a normal deployment, where the
package is installed from the registry rather than linked, they are under the
application's own `node_modules`. Either way, use what the command prints.

Neither path may contain a space: Harper compares `command.split(" ")[0]`, so a path with a
space in it cannot be allowlisted by any configuration.

## 3. Configure the node

Merge the blocks from `harper-config.example.yaml` into `<ROOTPATH>/harper-config.yaml`,
substituting the two paths from step 2. Merge, do not replace: Harper reads one config file
and does not fall back to `defaultConfig.yaml` for keys a hand-written file omits.

**`harper-config.yaml` is the file, and on an installed node it is the only one.**
`harper install` writes it (`createBootPropertiesFile()` joins `HARPER_CONFIG_FILE`,
`utility/install/installer.js`) and records its absolute path in
`~/.harperdb/hdb_boot_properties.file` as `settings_path`. A booted node reads whatever that
line names, so the filename is not even consulted. Only when Harper runs with `ROOTPATH` set
and no boot file does it probe by name: `harper-config.yaml` first (`HARPER_CONFIG_FILE`),
then the legacy `harperdb-config.yaml` (`HDB_CONFIG_FILE`) if the first is absent
(`getConfigFilePath()`, `config/configUtils.js`). Exactly one file is ever parsed; there is no
merge across the two.

So creating `harperdb-config.yaml` next to the `harper-config.yaml` the installer already
wrote puts every key in a file nothing opens. The allowlist, both `threads` keys and the
`logging` level all go missing at once, and the only symptom is
`Command /... is not allowed` from the first spawn. `harperdb-config.yaml` is inherited from
the old `harperdb` package and survives only on nodes carried forward from it; nothing renames
it on upgrade. Every release of the `harper` package, 5.0 through 5.2, writes the new name.

**The template's name ends in `.example.yaml` deliberately.** A file literally named
`harper-config.yaml` sitting in the application directory is read as the node's real
configuration under `harper run .`: it would load the placeholder paths below, leave
`rootPath` unset so `database` and `keys/` resolve against the app directory, fail startup on
`Specified path <app>/database does not exist`, and then **overwrite the template** with a
generated config. Keep the shipped template under a name Harper does not claim.

```yaml
applications:
  allowedSpawnCommands:
    - npm # Harper's own defaults; your list replaces them, not extends
    - node
    - <core path from step 2>
    - <trace path from step 2>

threads:
  preloadRequire: dd-trace/init # starts the tracer
  preload: dd-trace/register.js # ESM loader hooks for http instrumentation

logging:
  file: true # the log source tails <rootPath>/log/hdb.log
  level: info # else the agents' startup lines are dropped
```

**Both `threads` entries are required and neither substitutes for the other.** Measured on
`dd-trace` 6.10.0, same endpoint, three ways, against a receiver on 8126:

| Worker flags | `tracerInitialized` | Spans received |
| --- | --- | --- |
| neither | `false` | none |
| `--import dd-trace/register.js` only | `false` | none |
| `--require dd-trace/init` | `true` | all four |

`register.js` installs loader hooks and never calls `init()`. The failing rows do not
throw, and `GET /Work/` still returns a plausible trace id, because an uninitialised
`dd-trace` hands out `NoopSpan`s with real-looking ids. `tracerInitialized` in the response
is the only reliable signal.

Restart Harper after editing. The allowlist is captured once at module load
(`const ALLOWED_COMMANDS = new Set(...)`), so an edit without a restart looks exactly like
the edit being ignored.

## 4. Set the environment

```bash
export DD_API_KEY=<your key>          # omit to run without an account, see below
export DD_SITE=datadoghq.com
export DD_ENV=development
export DD_SERVICE=harper-example      # must match `service` on the log source
```

These are Datadog's own variables. The supervisor invents none of its own: the runtime
directory and the log path are derived from Harper's root path, which is `ROOTPATH` when the
image sets it and otherwise comes from `~/.harperdb/hdb_boot_properties.file` by way of the
`settings_path` it names. See [Non-root paths](#non-root-paths).

`DD_API_KEY` is read from the environment and deliberately never written into the generated
`datadog.yaml`.

## 5. Start Harper

```bash
harper run .
```

Expected in `hdb.log`, in this order:

```
Datadog supervisor: Harper's constrained child_process is active (probe rejected with
  "Command harper-datadog-spawn-probe-must-not-exist is not allowed"). ...
Datadog supervisor: started the trace-agent (pid 1234): /.../bin/trace-agent run -c /.../datadog/datadog.yaml
Datadog supervisor: started the core agent (pid 1235): /.../bin/datadog-agent run -c /.../datadog
Datadog supervisor: the trace-agent is serving the APM receiver on 127.0.0.1:8126; dd-trace
  has somewhere to send spans.
```

The last line is the only one that is a measurement rather than a report. If it says the
trace-agent was started but nothing answered `/info`, the agent is running and dd-trace is
dropping every span; read `<runtime dir>/logs/trace-agent.log` and check `DD_APM_ENABLED`,
which overrides the `apm_config.enabled` this supervisor writes.

Other worker threads print this instead, which is the correct outcome:

```
Datadog supervisor: the trace-agent is already running on this node (pid 1234); this thread
  joined it instead of starting a second one.
```

The first line is the one to check. If it says `HARPER'S SPAWN INTERCEPTION IS NOT ACTIVE`,
stop: there is no singleton, every worker thread starts its own pair, and all but one
trace-agent dies on `EADDRINUSE` without saying so. See
[How the singleton works](#how-the-singleton-works).

## 6. Call the endpoint

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

`tracerInitialized: true` is the assertion that matters. If it is `false`, the trace id
beside it belongs to a `NoopSpan` and nothing was sent; go back to step 3.

The request produces a three-span trace (`harper.work.request`, with `harper.work.compute`
and `harper.work.io` beneath it) and two log entries: an `info` line and a `warn` carrying
an `Error` whose stack runs to three physical lines. The second one exercises the
`multi_line` rule in `conf.d/harperdb.d/conf.yaml`; without that rule each `at ...` frame
arrives in Datadog as its own log entry.

## 7. Ask whether it is actually delivering

```bash
curl -s -u HDB_ADMIN:password http://localhost:9926/DatadogStatus/ | jq .delivery
```

```json
{
	"source": "https://127.0.0.1:5012/debug/vars",
	"window": "the last completed minute; the agent resets these counters, so they are not cumulative",
	"verdict": "delivering",
	"detail": "the intake accepted 3 payload(s) in the last minute.",
	"receiver": { "tracesReceived": 20, "spansReceived": 80, "payloadRefused": 0, "clients": ["nodejs 6.12.0"] },
	"statsWriter": { "payloads": 3, "errors": 0, "retries": 0 },
	"everDelivered": true
}
```

| `verdict` | What it means |
| --- | --- |
| `delivering` | The intake accepted an authenticated payload in the last minute. |
| `rejected` | Payloads went out and every one came back refused. Check `DD_API_KEY` and `DD_SITE`. |
| `not-delivering` | Spans are arriving at the agent and none have been accepted. Read it again first: both windows reset each minute. |
| `idle` | Nothing arrived in the last minute. `everDelivered` says whether this thread ever saw delivery work. |
| `unavailable` | Nothing answered the expvar endpoint. The trace-agent is not running. |

**Do not read `Traces: 0 payloads` off `datadog-agent status`.** That section renders
`trace_writer` out of the trace-agent's expvar, and on 7.73.0 through at least 7.82.1 that key
is zero no matter what the agent is doing. Upstream constructs a `TraceWriter` and a
`TraceWriterV1` unconditionally (`pkg/trace/agent/agent.go`), each starts a `reporter()`
goroutine whose second statement is `info.UpdateTraceWriterInfo(w.statsLastMinute)`, and that
function assigns one global pointer (`pkg/trace/info/writer.go`). Last registration wins, and
the v1.0 writer receives nothing from a tracer posting to `/v0.4/traces`, so the published
struct usually belongs to a writer that never sends anything. Measured against the shipped
binary: 55 samples over two minutes, spans flowing, payloads retried and dropped, and all nine
`trace_writer` fields zero in every sample while `receiver` and `stats_writer` moved normally.

`stats_writer` is what `delivery` reads instead, and it is a real signal rather than a stand-in
for one. It has a single producer, so it cannot lose that race; its `Payloads` counter
increments only on the sender's 2xx branch; and its payloads go to the same host with the same
API key over the same sender as the trace payloads, built only from spans that were actually
received. Verified with a deliberately wrong key: the receiver counters climbed,
`stats_writer.Retries` climbed, and `Payloads` stayed at zero.

## Verifying without a Datadog account

The trace-agent accepts spans whether or not the API key is valid, so everything up to the
intake works with `DD_API_KEY` unset.

```bash
# Receiver up and advertising the endpoint dd-trace posts to. A number means yes.
curl -s 127.0.0.1:8126/info | jq -e '.endpoints | index("/v0.4/traces")'

# Exactly one of each process, regardless of thread count.
ls <ROOTPATH>/pids/                                  # datadog-agent.pid  datadog-trace-agent.pid
pgrep -f 'bin/(datadog-agent|trace-agent)' | wc -l   # 2

# The whole picture, including whether spawn interception is live. The trace-agent's
# `receiverBound` is the field to read: `started` only means spawn did not throw.
curl -s -u HDB_ADMIN:password http://localhost:9926/DatadogStatus/ | jq
```

`/DatadogStatus/`'s `delivery.receiver` carries the same counters without a log file. Reading
the log directly still works, and is the only place a trace payload's own round trip is
printed:

```
[TRACE] ... INFO (...): [lang:nodejs ...] -> traces received: 4, traces filtered: 0,
        traces amount: 1234 bytes, events extracted: 0, events sampled: 0
```

## Verifying with a Datadog account

- **APM**: search `trace_id:<traceId from the response>`, or filter by
  `service:harper-example`. `harper.work.request` should have two child spans.
- **Logs**: search `service:harper-example`. The `warn` entry should arrive as **one** log
  whose message contains the whole stack trace. One entry per `at ...` line means the
  `multi_line` rule is not reaching the agent: check `confd_path` in the generated
  `datadog.yaml` and that `<runtime dir>/conf.d/harperdb.d/conf.yaml` was written.
- **Correlation** needs the log source's `service` to match `DD_SERVICE`. Both are set from
  `DD_SERVICE` here for that reason.
- **Host metrics**: a metrics summary filtered on `system.cpu` should list something. Nothing
  there while `datadog` lists a hundred-odd metrics means the runtime `conf.d` has no check
  configuration in it: `datadog.agent.running` comes from the aggregator on every flush, not
  from a check, so the pipeline reports success while carrying nothing about the host.
  `datadog-agent status -c <runtime dir>` names every check that ran.

A missing `DD_API_KEY` produces no error anywhere: the receiver accepts spans, batches them,
and discards them when the intake rejects the payload, and `dd-trace` sees a successful
flush either way. The supervisor's startup warning is the only notice you get.

## How the singleton works

Harper does the deduplication. Component code never receives the real `node:child_process`;
`security/jsLoader.ts` substitutes a constrained module with three gates, in order:

1. **Allowlist.** `ALLOWED_COMMANDS.has(command.split(" ")[0])`, else
   `Command <x> is not allowed`.
2. **Mandatory name.** `spawn` without `options.name` throws.
3. **PID-file lock.** `openSync("<rootPath>/pids/<name>.pid", "wx")`. Whoever creates the
   file spawns; everyone else gets an `ExistingProcessWrapper` for the running PID.

Because the lock is a file rather than in-process state, it dedupes across worker threads
and across processes sharing a root path, with no leader election. Two distinct `name`
values take two independent locks, which is what lets the core agent and the trace-agent
each be a singleton without blocking the other.

Three consequences the supervisor handles:

- **Losers get a stub.** `ExistingProcessWrapper` exposes `pid`, `kill()`, `unref()` and an
  `exit` event, and **no `stdout`/`stderr`/`stdin`**, so `child.stdout.on(...)` throws a
  `TypeError` on every thread that lost the race. Its liveness poll is a 1 Hz `setInterval`
  that is never unref'd, so the thread must call `child.unref()` or its event loop stays
  pinned through shutdown.
- **`error` has no listener.** Harper registers only `exit`, and Node promotes an unhandled
  `error` on a `ChildProcess` to an uncaught exception, killing the worker. The supervisor
  attaches its own listener immediately after `spawn` returns, before any other branch.
- **`version` forces a replacement.** Harper compares `options.version` against line 2 of
  the PID file and, on a mismatch, SIGTERMs the running process and re-acquires the lock.
  The supervisor passes a hash of the resolved binary paths plus the generated config, so a
  changed binary or config replaces the agents instead of adopting a stale one. It must be
  a **number**: Harper reads the recorded value with `parseInt()` and compares with `!==`,
  so a string version never equals itself and every thread would kill and respawn forever.

### Why the supervisor is imported relatively

`shouldUseApplicationLoader()` decides which modules get the constrained `child_process`:

```js
if (specifier.startsWith(".")) return true; // relative -> always
...
if (resolvedUrl.includes("/node_modules/"))
    return packageDependsOnHarper(resolvedUrl); // npm dep -> only if it needs Harper
return false;
```

Move `dd-supervisor.js` into an npm package that does not itself depend on `harper` and it
is loaded natively with the real `child_process`: no allowlist, no name requirement, no PID
lock. It would start one core agent and one trace-agent per worker thread and look healthy
doing it.

The same applies to how the builtin is imported. Harper's CommonJS shim forwards anything
that is not a `file:` URL straight to the real `require` without consulting the substitution
table, so `require("node:child_process")` returns the unconstrained builtin. Only the ESM
`import` path runs the check. Hence `import { spawn } from "node:child_process"`, never
`require`.

Because all of that is invisible when it goes wrong, `dd-supervisor.js` proves it at
startup: it tries to spawn a command that cannot exist and requires the attempt to be
refused. Under Harper that throws `Command ... is not allowed` synchronously, with no
process and no PID file created; under real Node it does not throw at all.

## Shutting down

Harper does not stop what a component spawned. `harper stop` sends one SIGTERM to one PID, the
main process named in `<ROOTPATH>/hdb.pid` (`bin/stop.js`); the handler sets a flag, removes
that file and calls `process.exit(0)` (`bin/run.js`). Worker threads are told nothing, and a
worker's own `process.on('exit')` does not run when the main process exits (measured on Node
24: neither `worker.terminate()`, nor `process.exit()` on main, nor SIGTERM to main fires it).
Nothing sweeps `<ROOTPATH>/pids/`. Left alone, both agents survive the node, 8126 stays bound,
and the PID files keep naming live processes.

The obvious fix is worse than the defect. Agent lifetime is decoupled from the worker thread
that won the spawn race **on purpose**: Harper recycles worker threads, and an agent tied to
one dies every time. The one lifecycle hook a component gets, `scope.on('close')`, fires on
exactly that recycle and stays silent on `harper stop`, so building on it would kill the agents
on the event they were built to survive.

So `dd-supervisor.js` starts a third process. `dd-reaper.js` takes its own PID lock
(`datadog-agent-reaper`), which makes it one per node and decoupled from any thread in the same
way the agents are. Because worker threads share a process, a spawn from a worker is a child of
the **main** Harper process, so the reaper's parent is the PID `harper stop` signals. When that
PID disappears it SIGTERMs each agent, escalates to SIGKILL after 5 seconds, and removes the
PID files, its own included.

It runs as `node dd-reaper.js`, which needs `node` in `allowedSpawnCommands`. That is already
Harper's default and is in the template; the supervisor tries this Node's absolute path first,
so allowlisting `process.execPath` works too and is immune to `PATH`.

Two things it deliberately does not do:

- **`harper restart` does not stop the agents.** Restart forks a fresh main process and exits
  the old one, so the parent dies on a path where the agents should be kept. The reaper waits 8
  seconds for a new `hdb.pid` to appear and stands down if one does, leaving the agents for the
  new node to adopt. That window also keeps the reap from racing the new node's workers into
  the PID files, which is the failure that does not heal: a worker that adopts a PID about to
  be killed joins a corpse and reports "already running" forever.
- **SIGKILL to Harper leaves `hdb.pid` behind**, because the handler that removes it never
  runs. The reaper still reaps: the parent is gone and the PID in the stale file is not alive.

What it cannot cover: SIGKILL to the reaper itself, and a machine that loses power. Both leave
the original defect, and both leave PID files that Harper's own lock treats as stale and
removes on the next start (`acquirePidFileLock` checks `isProcessRunning`).

`/DatadogStatus/` reports it under `reaper`, deliberately outside `agents` so that counting
agents keeps meaning what it meant.

## Non-root paths

The deploy target runs as a non-root user (`USER harperdb` on `node:24-trixie`), where every
Datadog default location is unwritable: `/etc/datadog-agent`, `/opt/datadog-agent`,
`/var/log/datadog`, `/var/run/datadog`. The supervisor writes a `datadog.yaml` on every start
that relocates all of them under the runtime directory:

```yaml
confd_path: <runtime>/conf.d
run_path: <runtime>/run
auth_token_file_path: <runtime>/run/auth_token
ipc_cert_file_path: <runtime>/run/ipc_cert.pem
disable_file_logging: true
log_file: <runtime>/logs/agent.log
bind_host: "127.0.0.1"
apm_config:
  enabled: true
  receiver_port: 8126
  apm_non_local_traffic: false
  log_file: <runtime>/logs/trace-agent.log
```

File logging is disabled *and* both log paths are relocated, so an agent that ignores
`disable_file_logging` still writes somewhere it is permitted to instead of emitting a
permission-denied line per log line into Harper's own log.

The runtime directory is `<root>/datadog`, and the tailed log is `<root>/log/hdb.log`, where
`<root>` is `ROOTPATH` if the environment carries it and otherwise the `rootPath` read out of
Harper's own configuration: `~/.harperdb/hdb_boot_properties.file` names the settings file in
a `settings_path = <path>` line, and that file carries `rootPath` at the top level. Every step
degrades rather than throws, so a missing boot file, an unreadable one, or a `settings_path`
pointing at nothing falls through to the next candidate. With no root path anywhere the
runtime directory becomes `~/.harper-datadog` and log collection is skipped with a line saying
so; traces are unaffected.

The component's own directory is deliberately not used as the runtime directory: `harper
deploy` replaces it, which would delete the run directory out from under a live agent.

The two binaries disagree about `-c`, verified against the shipped binaries: the core
agent's `-c`/`--cfgpath` is the **directory** containing `datadog.yaml`, and the
trace-agent's `-c`/`--config` is the **file** itself (its help text claims directory, but
its compiled default is `/opt/datadog-agent/etc/datadog.yaml`). The trace-agent also
requires that file to exist (contents irrelevant, an empty file works) and its directory to
be writable, since it writes its auth token there. The supervisor creates both up front and
checks writability before spawning.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `HARPER'S SPAWN INTERCEPTION IS NOT ACTIVE` | Supervisor not reached by a relative import, or `child_process` pulled in with `require()`, or `applications.moduleLoader: native`. |
| `Command /... is not allowed` | Most often the whole config edit landed in a file Harper never opened: on an installed node it reads the absolute path in `settings_path` (`~/.harperdb/hdb_boot_properties.file`), which is the `harper-config.yaml` the installer wrote, and a hand-created `harperdb-config.yaml` beside it is never parsed. Failing that, the path is not in `allowedSpawnCommands`, or contains a space, or Harper was not restarted after the edit. |
| Every node-level key looks ignored at once | Same cause. `threads.preloadRequire` missing (`tracerInitialized: false`), the allowlist missing, and `logging.level` still at `warn` in one go is the signature of editing the wrong file. `cat $(grep settings_path ~/.harperdb/hdb_boot_properties.file \| cut -d= -f2)` prints the one Harper reads. |
| `tracerInitialized: false` | `threads.preloadRequire: dd-trace/init` missing. `preload` alone initialises nothing. |
| `curl 127.0.0.1:8126/info` refused | trace-agent not running. Check `hdb.log` and `<runtime>/logs/trace-agent.log`. |
| trace-agent exits immediately, non-zero | Something else holds 8126, or `datadog.yaml` is missing at the path passed to `-c`. |
| trace-agent hangs ~30s then dies on its auth token | Its config directory is not writable. |
| Stack traces arrive as one log per line | The `multi_line` rule is not reaching the agent. Check `confd_path` and the rendered `conf.d/harperdb.d/conf.yaml`. |
| Nothing in Datadog, no errors anywhere | `DD_API_KEY` unset or wrong. Spans and logs are accepted locally and dropped at the intake. `/DatadogStatus/` reports `verdict: "rejected"` for this. |
| `datadog-agent status` says `Traces: 0 payloads` | Not a symptom. `trace_writer` is zero on 7.73.0 through at least 7.82.1 whatever the agent is doing; two writers race for one expvar slot. Read `/DatadogStatus/`'s `delivery` instead. |
| `delivery.verdict` is `unavailable` | Nothing answered `https://127.0.0.1:5012/debug/vars`. The trace-agent is not running, or `apm_config.debug.port` was moved by `DD_APM_DEBUG_PORT`. |
| Agents still running after `harper stop` | The reaper did not start. Check `hdb.log` for `Harper refused to start the agent reaper` and put `node` back in `allowedSpawnCommands`, or read `<runtime dir>/logs/reaper.log`. |
| Agents restarted by `harper restart` | Expected only if the new node took longer than 8s to write `<ROOTPATH>/hdb.pid`. The reaper stands down for a replacement it can see. |
| Agent startup lines absent from `hdb.log` | `logging.level` is `warn` (Harper's default). Set it to `info`. |
| `no log source was written, because Harper's root path could not be determined` | `ROOTPATH` is unset and `~/.harperdb/hdb_boot_properties.file` is absent, or its `settings_path` names a config with no absolute `rootPath`. Export `ROOTPATH`. |
| Log source configured but nothing arrives | `logging.file` is off, or `logging.root`/`logging.path` moved the log off `<rootPath>/log/hdb.log`, which is the only place the source looks. |
