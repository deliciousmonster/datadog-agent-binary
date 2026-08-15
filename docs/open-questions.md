# Open questions

Each of these is blocked on a decision rather than on engineering. The work behind them is
prepared; what is missing is an answer only the customer can give. Each entry states the question,
what turns on it, and what happens if it is deferred.

## 1. Which delivery path

**Question:** Contribute the fix upstream to `HarperFast/datadog-agent-binary`, or publish under a
separate scope from a repository we control.

**What turns on it:** Release timing, and whose npm namespace the customer depends on. The two are
mutually exclusive in practice, because npm provenance binds the attestation to the repository
that built the artifact, and the release preflight refuses to publish when the manifest's
repository and the building repository disagree.

**If deferred:** The upstream path stays open and nothing is lost, since the repointing change is
a handful of lines held in reserve. Deferring costs schedule, not optionality. Full detail in
[delivery options](delivery-options.md).

## 2. Are host metrics and log forwarding in scope

**Question:** Does the customer require host metrics and log collection from this package, or only
APM.

**What turns on it:** The shape of the deliverable. Shipping the trace-agent alone genuinely
works: measured against the real binary as a non-root user in a slim container, it answers
`/info`, accepts a `v0.4` trace payload, and reaches Datadog's edge with no core agent present.
Its dependencies on the core agent degrade rather than fail. One binary instead of two means one
allowlist entry, one process, and a smaller package.

The two-binary recommendation rests on keeping host metrics and log forwarding, which the customer
has working today and which the existing launcher warns about specifically. If those are handled
elsewhere, or not required, the simpler single-binary shape becomes the better answer.

**If deferred:** The two-binary design is the safe default, because it preserves behaviour the
customer currently has. Deferring costs package size and one allowlist entry, not correctness.
Worth answering early, since it is the only open question that changes the architecture rather
than the packaging.

## 3. Renaming the platform packages

**Question:** Rename platform packages from this project's vocabulary (`-linux-x86_64`,
`-macos-arm64`) to Node's (`-linux-x64`, `-darwin-arm64`).

**What turns on it:** It removes the defect class that produced an uninstallable macOS package,
because the manifest values and the package name would derive from one table rather than two. It
is also breaking for anyone pinning a platform package directly, and those packages are already
published under the customer's namespace, so it is their call rather than ours.

**If deferred:** The existing names stay and the pre-publish matrix gate is the safeguard instead.
That is a real safeguard; the rename is the stronger version of it. The recommendation is to do it
in the same release as any scope change or not at all, so consumers absorb one rename rather than
two.

## 4. Deprecating the package that cannot install

**Question:** Deprecate `@harperfast/datadog-agent-binary-macos-x86_64@7.75.5`.

**What turns on it:** It was published with `os: ["macos"]` and `cpu: ["x86_64"]`, which npm
compares against `darwin` and `x64`, so it matches no machine. A published version can be
deprecated but never replaced, so deprecation with a message pointing at the correct package is
the only available action. It is the customer's npm namespace.

**If deferred:** Anyone resolving that package continues to get a silent skip and no binaries. The
cost of deferring is borne by whoever hits it next, and they get no error message to work from.

## 5. Alpine and musl

**Question:** Is a musl-based deployment target in scope.

**What turns on it:** Both binaries link glibc dynamically, because the trace-agent's `netcgo`
build tag rules out a static build. npm matches Alpine identically to Debian, so an Alpine
consumer installs the Linux package successfully and then the spawn fails with an error that reads
like a missing file.

**If deferred:** Official Harper images are Debian-based, so this is latent rather than active.
Declaring `libc: glibc` on the Linux manifests is cheap and makes a musl consumer skip the
optional dependency and hit the explicit no-binary path with a real message, which is worth doing
regardless. A genuine musl build leg is a separate piece of work and only justified by a real
deployment.

## 6. The Harper spawn contract is undocumented

**Question:** Should Harper's spawn semantics become supported, documented API, or should the
component avoid depending on them.

**What turns on it:** The one-process-per-node behaviour rests on Harper's PID-file lock, a
mandatory spawn `name`, and a numeric `version` contract. Searching Harper's documentation
repository for the internal names behind those returns nothing; only `allowedSpawnCommands` is
documented. The design depends on behaviour that is currently an implementation detail and could
change in a patch release without anyone considering it a break.

**If deferred:** The component keeps working and carries a latent coupling. The two ways to
resolve it are to get the contract written into Harper's component documentation so it is
supported, or to move to a claim-with-heartbeat pattern that Harper already uses elsewhere and
does not depend on the undocumented parts.

## 7. A contradiction worth raising with Datadog

**Question:** Do we report the dd-trace worker-thread finding upstream.

**What turns on it:** Datadog's configuration documentation states that `register.js` alone
instruments worker threads. Measured against a live receiver on dd-trace 6.10.0 and Harper 5.2,
that configuration produces `tracerInitialized: false` and zero spans; the tracer only initialises
with `--require dd-trace/init`. Either the documentation is wrong or the behaviour is, and the
next person to follow the documentation loses their traces the same way.

**If deferred:** Nothing breaks for this customer, because the requirement is captured in the
configuration we recommend. The measurement should be labelled as observed on those specific
versions rather than asserted as general behaviour.

## What is not open

ESM-only rather than a dual build. This was framed as a product question - dual if the Harper
server itself might ever consume the package - and a census across the organisation's repositories
found zero server-side consumers, with every actual consumer component-side and already ESM.
A dual build also does not hedge the scenario it appears to: inside Harper's application loader it
re-selects the CommonJS artifact for exactly the population the conversion serves.
