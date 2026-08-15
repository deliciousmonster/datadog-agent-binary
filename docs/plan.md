# Delivery plan

Five phases. Each one ends on a check the customer can run rather than a status we report.

Effort figures are engineering time for the work itself, and exclude review latency on the
upstream path, which is not ours to schedule.

## Phase 0: reproduce the failure locally

Stand up a Harper node with an application that emits spans, and confirm the failure in the
customer's shape: spans created, flushed, and dropped, with no error in the application log.

This phase exists because a fix for a silent failure has to be demonstrated against the silence.
Without a local reproduction there is no way to distinguish "the fix worked" from "something else
changed", and no way to show the customer the before state.

Gate: the reproduction produces zero spans at the receiver and zero errors in the application,
matching the reported symptom.

**Effort: half a day.**

## Phase 1: ship the trace-agent

The core change, at every layer where the binary is currently absent.

- A second upstream build task for the trace-agent, with no build-exclude flags, since the flags
  the core agent needs are wrong rather than redundant for a plain Go build.
- Copy from the path upstream actually writes, `bin/trace-agent/trace-agent`, rather than the
  hardcoded `bin/agent` the current copy step assumes.
- Model the binaries as a descriptor list so building, packaging and resolution iterate one source
  of truth.
- Publish both binaries in every platform package, with an accessor for each.
- A shim for each, and a distinct Harper spawn name for each, which is what makes the PID-file
  lock produce one core agent and one trace-agent rather than one process total.
- Pin the upstream Datadog release, and fail the build when the checkout does not match the
  requested ref.

Version pinning is in this phase rather than later because it is a prerequisite: the two binaries
share an IPC auth handshake and a config schema, so building them from independently resolved refs
can produce a pair that does not interoperate.

Gate: the receiver answers `/info` advertising `/v0.4/traces`, and the local reproduction from
Phase 0 now shows spans arriving.

**Effort: two to three days.**

## Phase 2: make the absence detectable

The tests that would have caught the original defect, plus the packaging gates.

- Integration against a real Harper process rather than a stub binary and a hand-written model of
  the enforcement rules.
- A packaging gate that runs before publish: every declared platform built, npm-valid `os` and
  `cpu` values, and no platform package missing the trace-agent.
- End-to-end verification of all three telemetry pillars using an invalid API key, so the checks
  need no Datadog account.
- Hermetic unit tests for the invariants that only fail as silent data loss.

Gate: deliberately removing the trace-agent from the build causes a red test. That is the check
that matters, and it is worth running as an explicit exercise rather than assuming.

**Effort: two to three days.**

## Phase 3: supply chain and release pipeline

- Pin every GitHub Action to a commit SHA, starting with the publish job, which holds
  `id-token: write` and publishes with provenance.
- Trusted publishing rather than a long-lived token, with the token retained only as a first-publish
  bootstrap.
- Publish platform packages before the main package, so the main package never advertises optional
  dependencies that do not yet exist.
- Re-verify the published matrix against the live registry after publishing, and on a schedule.

Gate: a published version can be independently verified by a third party from its provenance
attestation and the registry's own file listing.

**Effort: one to two days.**

## Phase 4: the reference component

The example a customer copies is part of the deliverable, because a correct package used through
an incorrect supervisor still produces one agent per worker thread.

- Gate agent launch on a positive check that Harper's spawn interception is actually active, and
  fail loudly when it is not.
- Handle the race loser correctly: it receives a handle without stdio, and its liveness interval
  must be released or the thread never goes idle.
- Decouple agent lifetime from the winning thread, so a rolling worker restart does not terminate
  both agents while leaving the PID file behind. Development mode triggers that on every file
  save.

Gate: at any worker-thread count, exactly one core agent and one trace-agent, with one PID file
per spawn name.

**Effort: one to two days.**

## Phase 5: decisions that need the customer

Prepared work that costs one answer each rather than one implementation each. These are set out in
[open questions](open-questions.md); the shape is that each is blocked on a decision only the
customer can make, not on engineering.

**Effort: hours per item once answered.**

## Risks, ranked

| Risk | Mitigation |
| --- | --- |
| The fix ships and the customer cannot tell whether it worked, because the failure was silent | Every acceptance criterion is observable locally with an invalid API key; the intake's 403 is positive proof the payload was real and arrived |
| Customer runs a Harper below 5.1.18, where `preloadRequire` is ignored rather than rejected | Version floor checked and stated; the endpoint reports `tracerInitialized` explicitly, since a trace id proves nothing |
| Only one of the two paths is allowlisted, reproducing the original symptom exactly | Documented as a required consumer action, and the supervisor fails loudly rather than continuing with one agent |
| Non-root paths silently break the trace-agent, appearing as a 30 second hang and an auth-token error | Pre-spawn checks for both pre-bind failure conditions, naming the offending path |
| A platform is declared but never built, so npm skips it without error | Pre-publish matrix gate; declared and built sets must be identical |
| Two binaries built from different upstream refs fail their IPC handshake | Single pinned ref, and a mismatched checkout is fatal |

## What the customer needs to supply

Access to a representative Harper version and configuration, a decision on the delivery path, and
answers to the open questions. A Datadog account is needed only for final production confirmation,
not for any acceptance check in phases 0 through 4.
