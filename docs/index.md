# Harper + Datadog: restoring APM trace delivery

Server-side APM traces are not reaching Datadog from the Harper runtime. The cause is not
configuration. `@harperfast/datadog-agent-binary` ships the Datadog core agent and not the
trace-agent, so nothing binds `127.0.0.1:8126`, and `dd-trace` posts spans to a closed port and
drops them.

The published artifact settles it without needing access to your environment. The 152 MB binary in
`@harperfast/datadog-agent-binary-linux-x86_64@7.75.5` contains zero symbols from the Go package
that owns the APM receiver, and zero occurrences of the endpoint the tracer posts to. A control
probe against a package that should be present returns 809, so the extraction is sound.

This is a missing process. Application-level configuration could not have fixed it, which is why
the configuration work already attempted did not change the result.

## What makes it hard to see

The core agent parses the APM configuration keys it cannot serve, and `datadog-agent status`
renders an APM section drawn by status shims that contain no receiver. An operator setting
`DD_APM_ENABLED` sees it accepted, sees a status page with an APM heading, and sees no traces.
Every available signal points at configuration.

On the application side, `dd-trace` classifies a refused connection as a normal startup race. A
process alive six seconds after its first flush prints nothing at all; one alive forty-five
seconds prints a single line. Short-lived work finishes before that line is due.

## Documents

| Document | What it covers |
| --- | --- |
| [Discovery](discovery.md) | The root cause, the artifact-level proof, the six independent layers where the binary is absent, the commit that removed it, and why five CI checks stayed green |
| [Architecture](architecture.md) | The proposed two-binary design, why bundling is not the cheaper option it appears to be, the one-agent-per-node model, and each advantage stated against the specific failure it removes |
| [Strategy](strategy.md) | Fix the process, then make the class of defect undetectable-by-accident; the sequencing argument and the risk posture |
| [Plan](plan.md) | Five phases, each ending on a check you can run, with effort figures and ranked risks |
| [Requirements](requirements.md) | The non-root deploy target, Harper's spawn contract, the tracer preload requirement, version floors, and the platform matrix |
| [Success criteria](success-criteria.md) | Twenty-one checkpoints, each a command with an expected output; only three need a Datadog account |
| [Testing](testing.md) | What each layer proves, why the existing checks were blind, and how all three telemetry pillars are verified without credentials |
| [Delivery options](delivery-options.md) | Upstream contribution versus publishing under a separate scope, why the two cannot be hedged, and what happens to the already-published packages |
| [Security](security.md) | Supply chain and the publish credential, API key handling, the spawn allowlist as a capability boundary, and what shipping an executable implies |
| [Open questions](open-questions.md) | Seven decisions that need an answer rather than engineering, each with what turns on it and what deferring costs |

## The shape of the work

Ship two binaries, because upstream builds two and the flag that appears to fold them into one
saves disk rather than a process, drops Windows APM without a warning, and fails soft in exactly
the way that let this defect ship thirty-four times.

Run them as one core agent and one trace-agent per node, using the PID-file lock Harper already
provides, keyed on two distinct spawn names.

Then make the absence detectable. The receiver is the deliverable; the checks that fail when it is
missing are what keep it delivered. Removing the trace-agent from the build should turn the test
suite red, and today it does not.

## What you need to decide

One answer changes the work rather than the schedule: whether host metrics and log forwarding are
in scope, because trace-agent alone is a simpler shape that genuinely works and gives those up.

The delivery path was settled on 2026-08-26, publishing under `@deliciousmonster` now and offering
the upstream PR after. npm provenance binds an artifact to the repository that built it, so
contributing upstream and publishing under a separate scope could not both stay open past the point
of publishing.

Everything else can be decided as the work proceeds.
