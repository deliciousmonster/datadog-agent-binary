# Testing and verification

The defect that started this engagement was invisible to five separate CI checks. Any test
strategy that does not explain why it would have caught a missing receiver is not worth
proposing, so each layer below is stated in terms of the failure it detects.

## Why the existing checks were blind

The release smoke test runs `datadog-agent version`, which prints and exits without binding
anything. The glibc check reads one hardcoded path with `readelf`. The platform-package test runs
the generator in a mode that skips binary copying entirely and asserts on metadata. The component
test fabricates a stub binary that is a Node script echoing a marker, and models Harper's
enforcement with nine hand-written lines. The one script that boots real Harper is referenced by
no workflow, and installs a v4 runtime that has no `allowedSpawnCommands` at all, so it would pass
against a runtime with zero enforcement.

The common property: every check asserts on something adjacent to the behaviour rather than the
behaviour. A test that cannot fail when the receiver is absent does not test the receiver.

## What each layer must prove

**Unit.** The invariants that only surface as silent data loss: the receiver port derivation, the
run-subcommand detection, the receiver health probe, the checkout-matches-requested-ref assertion,
the pinned-version read, and the both-binaries gate in the copy step. These are hermetic and fast,
and they exist because each corresponds to a way the product fails without saying anything.

**Packaging.** That every declared platform is built, that `os` and `cpu` carry npm-valid values
rather than this project's own vocabulary, and that no platform package ships without the
trace-agent. This runs before publish, because a published version can be deprecated but never
replaced.

**Integration against a real Harper process.** Not a stub, and not a hand-written model of the
enforcement rules. The reason is specific: a model of `allowedSpawnCommands` written by the same
people who wrote the code under test encodes the same misunderstanding twice, and the original v4
harness would have passed against a runtime where enforcement did not exist.

**Cross-platform.** Both binaries built and smoke-tested per platform, and both checked against
the glibc floor rather than one hardcoded path.

**End to end.** A real Harper node, the real packaged binaries, a real application emitting spans,
and an assertion that the receiver accepted them.

## Proving all three pillars without Datadog credentials

Metrics, traces and logs can each be proven end to end using a syntactically valid but deliberately
invalid API key. The failure modes are not symmetric, and that asymmetry is what makes the test
work:

- An **unset** key makes the agent disable its forwarder and never contact Datadog. That proves
  nothing.
- An **invalid** key leaves the whole pipeline live. The agent builds real payloads, opens real
  connections, and Datadog's intake rejects them with `403 Forbidden`.

A 403 from the intake is therefore positive evidence: the payload was constructed, it was real,
and it reached Datadog. The acceptance criterion is the 403, not its absence.

**Traces.** The receiver must answer `/info` advertising `/v0.4/traces`, and its own periodic
summary must show a climbing `traces received` count tagged with the application's service name.
The endpoint under test must report an explicit `tracerInitialized: true`, because an
uninitialised tracer still returns a plausible trace id from a no-op span, so asserting on the
presence of a trace id proves nothing.

**Metrics.** DogStatsD ingestion is measured as a delta against a control window rather than an
absolute count, because the agents emit their own telemetry continuously. Sample the aggregator's
counter over a window with no packets sent, then over an equal window with a known number sent.
The difference between the two deltas must account for the packets. An absolute count would be
indistinguishable from background noise.

**Logs.** The file source must report `Status: OK` against the Harper log path, with byte and
event counters advancing when the application writes. The multi-line rule is mandatory rather than
optional: Harper's log is multi-line plain text where stack frames continue on lines that do not
begin with a timestamp, and without the rule the agent treats every physical line as its own log.

## Version coverage

The suite must run against both the 5.1 and 5.2 Harper lines. `threads.preloadRequire` was
backported at 5.1.18, and below that floor the key is ignored rather than rejected: the tracer
stays a no-op, the endpoint still returns a real-looking trace id, and the only signal is the
explicit `tracerInitialized` flag. A test matrix that covers only the newest release cannot
distinguish "works" from "silently does nothing" on the version a customer may actually be
running.

## Acceptance criteria

These are the observable checks a customer can run without trusting our account of the work.

| # | Criterion | How it is checked |
| --- | --- | --- |
| 1 | Every platform package contains both binaries | `tar -tzf` the published tarball, or list the registry's file index |
| 2 | Published `os`/`cpu` are npm-valid | compare against `process.platform` / `process.arch` values |
| 3 | The declared and built platform sets are identical | matrix check, run before publish and re-run against the registry |
| 4 | The shipped agent version equals the labelled version | `datadog-agent version` against the pinned ref |
| 5 | The receiver binds and advertises the tracer's endpoint | `curl 127.0.0.1:8126/info` lists `/v0.4/traces` |
| 6 | Exactly one core agent and one trace-agent per node | process count and one PID file per spawn name, at any thread count |
| 7 | Spans reach Datadog | `traces received` climbing, and a 403 from the intake on an invalid key |
| 8 | Metrics reach Datadog | counter delta against a control window, and a 403 from the intake |
| 9 | Logs reach Datadog | source reports OK, counters advance, bytes sent are non-zero |
| 10 | A missing or unwritable config path fails loudly | one named error rather than a 30 second hang |

Criteria 5 through 9 are the ones that would have caught the original defect. None of the five
existing CI checks can produce any of them.
