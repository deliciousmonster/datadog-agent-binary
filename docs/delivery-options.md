# Delivery options

Two paths get the fix into the customer's hands. They are mutually exclusive in a way that is
worth understanding early, because the choice is enforced mechanically rather than by convention.

## Path A: contribute upstream to HarperFast

The work lands as a pull request against `HarperFast/datadog-agent-binary`, published under the
existing `@harperfast` scope, and consumers get it by upgrading a package they already depend on.

What it requires from the customer: an owner on the Harper side to review and merge, and
agreement on the breaking parts. Release cadence belongs to HarperFast.

What it gives up: control of timing. A PR of this size touches the build, the packaging, the
release pipeline, and the published platform metadata, and review capacity is not something we
can schedule.

## Path B: publish under a separate scope

The package publishes from a repository we control, under our own npm scope. Consumers change one
dependency name.

What it requires: the customer accepts a package published by us rather than by Harper, and
accepts that it diverges from upstream until and unless the two are reconciled.

What it gives: delivery on our schedule, and no dependency on another organisation's review queue.

The mechanical change is small. Publishing home appears in the root manifest's `repository`,
`bugs` and `homepage`, in two README links, and in one hardcoded link inside the platform-package
generator. Platform manifests inherit `repository` from the root, so the four generated packages
follow from the single root edit.

## Why the two paths cannot be hedged

npm provenance binds the attestation to the repository that built the artifact. The release
preflight checks the manifest's `repository.url` against the repository the build is running in,
and refuses to publish when they disagree. Repointing the manifest at our own repository therefore
means a build inside `HarperFast/datadog-agent-binary` fails that check, and vice versa.

That is the correct behaviour. Provenance whose repository field does not match the builder is
provenance that means nothing. The practical consequence: the repointing change is applied for
exactly one path at a time. It is applied now, at `18c8019`, for Path B, and it has to come back
out before an upstream PR can publish.

## What happens to the already-published packages

Four of the five existing `@harperfast` platform packages install correctly and ship a working
core agent. Whichever path is chosen, they keep working, and a consumer who does not upgrade sees
no change.

`@harperfast/datadog-agent-binary-macos-x86_64@7.75.5` is a separate matter. It was published with
`os: ["macos"]` and `cpu: ["x86_64"]`, values npm compares against `darwin` and `x64`, so it
matches no machine and never installs. A published version can be deprecated but never replaced,
so the only available action is to deprecate it with a message pointing at the correct package.
That is worth doing under either path, and it is the customer's call because it is their npm
namespace.

## The breaking change to sequence carefully

Platform packages are currently named with this project's own vocabulary: `-linux-x86_64`,
`-macos-arm64`, `-windows-x86_64`. Node's vocabulary is `linux`, `darwin`, `win32` and `x64`,
`arm64`. Renaming the packages to match removes the class of defect that produced the
uninstallable macOS package, because the values in the manifest and the values in the package name
would come from one table instead of two.

It is also a breaking change for anyone who has pinned a platform package directly. The
recommendation is to do it in the same release as any scope change or not at all, so consumers
absorb one rename rather than two. If neither a scope change nor a rename happens, the existing
names stay and the safeguard is the pre-publish matrix check rather than the naming.

## Recommendation

**Decided 2026-08-26: Path B first, Path A after.** The order below is inverted in practice. The
repointing commit is applied rather than held, `@deliciousmonster` is the publishing scope, and the
upstream PR follows once the fix is in the customer's hands. What changed is which path waits, not
the reasoning.

Offer the upstream PR first. The fix belongs in the package that has the problem, the customer
already depends on that package, and a merged upstream change costs them nothing in
namespace churn.

Prepare the separate-scope path in parallel and hold it. If upstream review does not converge on a
timeline the customer can accept, the fallback is a single small commit away rather than a
re-plan.
