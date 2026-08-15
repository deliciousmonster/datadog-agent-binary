# Requirements and constraints

These come from the deploy target and from Harper's own semantics, not from preference. Each one
changes what the implementation must do, and several of them fail silently when violated, which is
the failure mode this whole engagement exists to remove.

## The deploy target runs as a non-root user

The `harper-pro` image renames `node` to `harperdb` and sets `USER harperdb`. Every stock Datadog
location is therefore unwritable:

| Default path | Purpose | Writable? |
| --- | --- | --- |
| `/etc/datadog-agent/` | `datadog.yaml`, `conf.d/`, `auth_token` | no |
| `/opt/datadog-agent/` | install root, `run/` | no |
| `/var/log/datadog/` | `agent.log`, `trace-agent.log` | no |
| `/var/run/datadog/` | sockets, PID files | no |

Every one must be relocated explicitly. This has to be an enumerated checklist in the
implementation rather than left to defaults, because several of these fail quietly when the
directory is not writable.

The trace-agent is the sharp case. It writes its `auth_token` beside its config file, and an
unwritable directory does not produce a permission error: the process hangs for 30 seconds and
then dies reporting a failure to create or fetch an auth token, which reads like a network
problem. A missing config file is equally misleading, since the trace-agent's default is not the
core agent's `/etc/datadog-agent/datadog.yaml` but a path derived from where the executable sits,
which for a binary npm unpacked into `node_modules` is somewhere with no reason to hold one.

Writable roots are `/home/harperdb` and the `/home/harperdb/harper` volume. The Datadog runtime
tree belongs under the volume, alongside Harper's own state.

## Port 8126 is free, and should stay local

Harper exposes 9925, 9926, 9932 and 9933. The APM receiver's default port does not collide, so it
keeps the default and binds `127.0.0.1` rather than a routable address.

## PID files land on a persistent volume

Harper's spawn dedupe writes `<rootPath>/pids/<name>.pid`, and with `ROOTPATH` pointing at a
Docker `VOLUME`, those files survive a container restart while the processes they name do not.
Harper then tests liveness with `process.kill(pid, 0)` against a PID from a dead container's
namespace. Usually that PID no longer exists and the agent correctly respawns; if PID reuse
happens to hit, the agent is silently never started.

The requirement that follows: health-probe the receiver, do not trust the PID file. Asking the
receiver whether it is answering is the only check that distinguishes running from
recorded-as-running.

## Harper's spawn contract

A component may only spawn an executable that is launched with a `name` option and listed by exact
absolute path in `applications.allowedSpawnCommands`. Four properties of that check constrain the
design:

- The match is an exact string compare against the first space-delimited token. A bare command
  name never matches, a relative path never matches, and a path containing a space can never match
  at all, because the token is truncated at the space.
- Two paths must be allowlisted, not one. Allowlisting the core agent says nothing about the
  trace-agent, and allowlisting only the core agent reproduces the original symptom exactly:
  metrics and logs flow, the trace-agent spawn is rejected, traces vanish, and nothing looks
  broken.
- The list is read once at module load, so editing configuration while Harper runs changes
  nothing. A restart is required, and an edit without one is indistinguishable from the edit being
  ignored.
- The `version` option that forces process replacement is parsed with `parseInt`, so it must be a
  number. A string version never compares equal to itself, and every thread would terminate and
  respawn the agent forever.

## The tracer has to reach the worker threads

Both Harper `threads` entries are required and neither substitutes for the other. Measured on
dd-trace 6.10.0 against a live receiver:

| Worker flags | `tracerInitialized` | Spans received |
| --- | --- | --- |
| neither | `false` | none |
| `threads.preload` only (`--import dd-trace/register.js`) | `false` | none |
| `threads.preloadRequire` (`--require dd-trace/init`) | `true` | all |

`register.js` installs the ESM loader hooks that produce automatic HTTP instrumentation, and never
calls `init()`. The failing rows do not throw, and a request still returns a plausible trace id,
because an uninitialised tracer hands out no-op spans with real-looking ids. Any acceptance test
therefore has to assert on an explicit `tracerInitialized` signal rather than on the presence of a
trace id.

This contradicts Datadog's own documentation, which states that `register.js` alone instruments
worker threads. The measurement above is against dd-trace 6.10.0 and Harper 5.2 specifically, and
should be raised upstream as such rather than asserted as a general fact.

## Version floors

Harper **5.1.18 or later**. `threads.preloadRequire` was backported into the 5.1 line at 5.1.18;
before that the configuration key is ignored rather than rejected, the tracer stays a no-op, and a
request still returns a real-looking trace id. Below the floor the failure is silent, so the floor
has to be checked rather than assumed.

Node `^22.18.0 || >=24.0.0`, matching Harper's own engines range.

## Platform support

| OS | Architecture | Status |
| --- | --- | --- |
| Linux | x86_64 | supported |
| Linux | arm64 | supported |
| macOS | arm64 | supported |
| Windows | x86_64 | supported |
| macOS | x86_64 | not supported: GitHub retired the Intel runner |
| Windows | arm64 | not supported: no native arm64 toolchain available |

The set of declared platforms and the set of built platforms have to be the same set, enforced
mechanically. A platform declared but never built becomes an `optionalDependency` that npm skips
without error, and the consumer gets no binaries and no explanation.

Both Linux binaries link glibc dynamically, because the trace-agent's `netcgo` build tag rules out
a static build. Official Harper images are Debian-based so this is currently latent, but an Alpine
or musl target would fail at spawn time with an error that reads like a missing file.

## Constraints on delivery mechanics

A published npm version can be deprecated but never replaced. Combined with silent
`optionalDependencies` failures, that means the verification which matters most has to run before
the publish, at the last moment the answer can still change anything, and be re-runnable against
the registry afterwards to catch later drift.
