# Success criteria

Every criterion below is a command with an expected output. None of them requires taking our word
for anything, and only three require a Datadog account.

That constraint is deliberate. The defect being fixed was silent, and the obvious verification -
open Datadog and look for traces - requires credentials, a configured account, and a working
application simultaneously. If those three have to line up before anyone can tell whether the work
succeeded, the feedback loop is too long to be useful and a partial failure is indistinguishable
from a configuration mistake at the customer's end.

## Gate order

The checkpoints run in sequence and the rule is: do not proceed past a failing checkpoint. A later
check passing does not excuse an earlier one failing, because the ordering is causal. A receiver
that answers `/info` while the binary contains no receiver symbols means something is listening
that is not what you think.

## The diagnosis, before any fix

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 1 | The shipped binary contains no receiver | `strings -a bin/datadog-agent \| grep -c 'pkg/trace/api\.'` | `0` |
| 2 | The extraction method works | `strings -a bin/datadog-agent \| grep -c 'pkg/aggregator'` | large, non-zero |
| 3 | The failure reproduces | application emits spans against a closed 8126 | zero spans received, zero errors logged |

Criterion 2 is the control. Without it, criterion 1 is indistinguishable from a broken command.

## The build

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 4 | The trace-agent is built and contains a receiver | `strings -a bin/trace-agent \| grep -c '/v0.4/traces'` | at least 1 |
| 5 | Both binaries come from one upstream ref | `datadog-agent version` and `trace-agent version` | identical version and commit |
| 6 | The shipped version equals the labelled version | compare `version` output against the pinned ref | equal |

Criterion 5 is not cosmetic. The two binaries share an IPC auth handshake and a config schema, so
a mismatched pair fails in a way that looks like a network problem.

## The package

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 7 | Every platform package ships both binaries | `tar -tzf <tarball> \| grep bin/` | two entries |
| 8 | `os` and `cpu` are npm-valid | compare against `process.platform` / `process.arch` values | `linux`/`darwin`/`win32`, `x64`/`arm64` |
| 9 | Declared platforms and built platforms are the same set | matrix check | no platform declared but unbuilt |

## The runtime

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 10 | The receiver binds and advertises the tracer's endpoint | `curl -s 127.0.0.1:8126/info` | lists `/v0.4/traces` |
| 11 | One core agent and one trace-agent per node | process count, and PID files under `<rootPath>/pids/` | one process and one PID file per spawn name, at any thread count |
| 12 | The tracer is actually initialised | application endpoint reports `tracerInitialized` | `true` |
| 13 | A bad config path fails loudly | point the launcher at a nonexistent config | one named error, not a 30 second hang |

Criterion 12 needs stating precisely: an uninitialised tracer still returns a plausible trace id
from a no-op span, so the presence of a trace id proves nothing. The explicit flag is the only
reliable signal.

## Telemetry reaching Datadog, without an account

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 14 | Trace payloads leave the agent | point the writer at a local fake intake | payload received locally |
| 15 | Spans reach Datadog's edge | run with a syntactically valid but invalid API key | `403 Forbidden` from the trace intake |
| 16 | Metrics reach Datadog's edge | same key, DogStatsD counter delta against a control window | delta accounts for packets sent; `403` from the metrics intake |
| 17 | Logs are collected and shipped | agent status logs section | source `Status: OK`, bytes sent non-zero |

Criterion 15 is the one that needs explaining, because it looks like a failure. An **unset** key
makes the agent disable its forwarder and contact nothing, which proves nothing. An **invalid**
key leaves the entire pipeline live: real payloads, real connections, and a rejection from
Datadog's own intake. The 403 is positive evidence that the payload was built, was real, and
arrived.

Criterion 16 measures a delta rather than an absolute count because the agents emit their own
telemetry continuously; an absolute number cannot be distinguished from background traffic.

## With a Datadog account

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 18 | Traces are queryable | search APM for the trace id returned by the endpoint | the trace, with child spans |
| 19 | Logs are queryable and correctly grouped | search logs for the service | a multi-line stack trace arrives as one event, not one per line |
| 20 | Traces and logs correlate | log source `service` matches `DD_SERVICE` | correlation works in the UI |

## Regression protection

| # | Criterion | Check | Expected |
| --- | --- | --- | --- |
| 21 | The suite can detect the original defect | remove the trace-agent from the build and run the tests | red |

This is the criterion that distinguishes the deliverable from the current state. Five CI checks
run against the package today and every one of them stays green with the receiver absent. A test
suite that cannot fail when the trace-agent is missing has not tested the trace-agent, and running
that removal as an explicit exercise is the only way to know.
