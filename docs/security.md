# Security considerations

This package builds binaries from source, publishes them to a public registry, and then a customer
executes them inside their runtime. Each of those steps is a place where the wrong control costs
more than the work itself.

## Supply chain is the one that decides it

There are several security items in this work; the one that actually decides the posture is
GitHub Actions pinning, because of what the release workflow holds.

The publish job needs `id-token: write` so npm can exchange an OIDC token for a short-lived
credential, and it publishes with `--provenance` so each tarball carries an attestation recording
which commit produced it. Both are the right controls. They also mean the workflow is a high-value
target: an action referenced by a mutable tag can be repointed by whoever controls that tag, and a
repointed action running in this job mints our publishing credential and ships whatever it likes
**under genuine provenance**. The attestation would be truthful and the artifact would be
poisoned.

Every `uses:` therefore pins a 40-character commit SHA with the human-readable version in a
trailing comment. There are 27 of them. The rest of the HarperFast organisation is already at 100%
pinning, so this is bringing one package up to a standard that already exists rather than
inventing a policy.

Automated dependency updates are configured so that pinning does not become staleness, since a SHA
pin that nobody advances is a security control that quietly turns into an unpatched dependency.

## Publishing credentials

Trusted publishing is the preferred path: configure a trusted publisher on npmjs.com for this
repository and workflow, leave `NPM_TOKEN` unset, and let npm exchange the OIDC token. Nothing
long-lived is stored.

A long-lived `NPM_TOKEN` remains only as a bootstrap fallback, because OIDC cannot authenticate a
package name that has never been published. The intended sequence is to publish once with the
token, configure the trusted publisher, then delete the secret. Two other packages in the
organisation still publish on long-lived tokens with no provenance, so this is a place where the
proposed work is ahead of house practice rather than catching up to it.

The release pipeline also asserts, after publishing, that a prerelease has not taken the `latest`
dist-tag. On a package's very first publish npm assigns `latest` regardless of `--tag`, because a
package with no dist-tags needs one, and the consequence is that everyone installing by default
gets a prerelease.

## The customer's Datadog API key

The key is read from the environment and is never written into any generated configuration file.
Diagnostics report it as `set` or `MISSING`, never by value, so an API key cannot reach a log
aggregator by way of our own startup output.

A keyless trace-agent is treated as a warning condition rather than an error, because it is the
most deceptive state: the receiver binds and accepts spans normally, and only the intake rejects
them, so the application sees successful flushes and an empty APM view is the only symptom.

## Executing binaries built elsewhere

The package delivers a 150 MB compiled binary that the customer's runtime then executes. That is a
meaningful transfer of trust and deserves stating plainly rather than burying.

Three properties bound it. The upstream Datadog release is pinned to an exact ref in a file in the
repository, so an artifact cannot be built from whatever upstream happened to have tagged that
day. A clone landing on a different ref than requested is treated as fatal rather than a warning,
so a mislabelled artifact cannot be produced silently. And provenance attestation ties each
published tarball back to the commit and workflow run that produced it, which is what lets a
customer verify the claim rather than accept it.

The binaries are Datadog's own source, built with Datadog's own build tasks. We are not patching
the agent.

## The spawn allowlist is a capability boundary

Harper only permits a component to spawn an executable listed by exact absolute path. That is a
real security control and the design works with it rather than around it. Two paths get
allowlisted, both absolute, both named explicitly, and the exactness is a feature: a prefix match
or a basename match would let a component substitute a different executable.

Worth being direct about a consequence: because the allowlist is exact-match on the first
space-delimited token, an installation path containing a space cannot be allowlisted by any
configuration. That is a deployment constraint, not something to work around in code.

## Filesystem posture

The deploy target runs as a non-root user, and every stock Datadog path is unwritable to it. The
Datadog runtime tree is relocated under the Harper volume rather than the agent being granted
write access to system locations. Nothing in the design requires elevated privileges, and the
receiver binds `127.0.0.1` rather than a routable address, so the APM receiver is not reachable
from outside the container.

## Integrity of what actually reaches the consumer

`optionalDependencies` failures are silent by design in npm, and a published version can be
deprecated but never replaced. Those two facts together mean a mistake in platform metadata
reaches consumers as an absence rather than an error, and cannot be corrected in place.

The proposed pipeline therefore verifies the platform matrix before publishing, at the last point
the answer can still change anything, publishes platform packages before the main package so the
main package never advertises dependencies that do not yet exist, and re-verifies against the live
registry afterwards on a schedule to catch a package being unpublished or altered later.
