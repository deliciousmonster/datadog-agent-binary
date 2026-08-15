# Strategy

Fix the missing process first, then make the package incapable of shipping that class of defect
again. Those are different pieces of work and the second is worth more than it looks.

## Why the hardening is not padding

The trace-agent work itself is bounded and well understood: add a second build task, copy a second
binary, model both, package both, resolve both, spawn both. That is a known shape.

What is not bounded is the reason nobody noticed for an entire release cycle. Five CI checks ran
against every build and none could observe a missing receiver, because each asserted on something
adjacent to the behaviour: a version string that binds no port, a metadata-only packaging test, a
stub binary that is a Node script echoing a marker, a v4 runtime with no enforcement to enforce.
A package that ships the trace-agent but keeps that test suite is one refactor away from shipping
without it again, and the failure would be just as silent the second time.

So the deliverable is the receiver plus the checks that would have caught its absence. Anything
that cannot fail when the receiver is missing does not count toward that.

## Sequencing, and the one ordering that matters

Two independent audits reviewed the package. Both recommended moving to ESM. They disagreed about
why, and the disagreement changes what happens first.

One reading held that ESM is the fix for Harper's loader claiming the package. The other traced
the routing predicate to its input: Harper's loader claims any installed package whose manifest
names `harper` in **any** dependency key, and this package named it in `devDependencies`, which
npm writes into the manifest of every published tarball. Remove that one key and the package is
loaded natively whether it is CommonJS or ESM.

The second reading is right and it is the more actionable one, because it turns a multi-day
migration into a one-line manifest edit that closes the actual break. ESM remains worth doing, but
it covers a narrower case: an operator who sets `applications.dependencyLoader: app`, which forces
every bare specifier through the application loader regardless of what the manifest says. That is
a configuration we do not control, so it is a real improvement and a separate one.

Ordering follows: drop the dependency key first, ESM later on its own merits.

## Parallel where the file territories are disjoint

The hardening work splits into lanes that touch non-overlapping parts of the tree: the manifest
and its consequences, the CI and supply-chain configuration, the reference component, and the test
suite. Those proceed simultaneously.

Two things force serialisation and are scheduled accordingly. Whole-repository formatting
conflicts with every other change by definition, so it lands alone and last. And within the
reference component, decoupling agent lifetime from the winning worker thread depends on the
supervisor's correctness fixes landing first, since the second change is meaningless against a
supervisor that gates on the wrong signal.

## Risk posture

The largest risk is not technical. It is that a fix ships and the customer still cannot tell
whether it worked, because the original failure was silent and the natural verification -
"traces appear in Datadog" - requires credentials, a configured account, and a working
application at the same time.

The mitigation is that every acceptance criterion is observable locally, without a Datadog
account, using a syntactically valid but invalid API key. The intake then rejects real payloads
with `403 Forbidden`, and that rejection is positive evidence: the payload was built, it was real,
and it reached Datadog. A customer can confirm the pipeline end to end before ever pointing it at
their production org.

The second risk is that the customer's environment differs from the test environment in a way that
reintroduces silence. Non-root paths, a Harper version below the `preloadRequire` floor, and an
allowlist missing the second path each produce a working-looking system with no traces. Each is
handled by making the failure loud at startup rather than leaving it to be inferred from an empty
dashboard.

## What is deliberately out of scope

The core agent's behaviour and its configuration surface. Host metrics and log forwarding work in
the customer's environment today, and this work adds a receiver alongside them rather than
reworking telemetry that already functions.
