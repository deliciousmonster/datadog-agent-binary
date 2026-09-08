# AGENTS.md

For whoever changes this repository. `README.md` is for whoever installs it.

## Layout

- `resources.js`, `runtime/`: the plugin Harper loads. `runtime/binary.js` resolves the binaries; `PACKAGE_NAME` there is a literal, never derived, because a deployed component's nearest `package.json` can carry any name. `runtime/supervisor.js` starts and watches the agents, through Harper's `scope.processes` where a build carries it and through `@deliciousmonster/harper-process-guard` otherwise.
- `src/`: the TypeScript build CLI that clones and compiles Datadog's agent. Not in the tarball; it needs `dda`, `go` and `pip`.
- `scripts/`: packaging and gates: `create-platform-packages.js`, `update-optional-deps.js`, `verify-package.js`, `smoke-test-binaries.js`, `windows-gate.mjs` with `windows-gate-checks.mjs`.
- `conf.d/`, `config.yaml`: shipped as written; the core checks ship or the core agent collects nothing.

## Versions

The package version is the Datadog version it pins in `.datadog-agent-version`, with a prerelease identifier of its own: `7.82.1-next.0`. A test holds the numeric core to the pin. The build reads the pin; the tag's version reaches only `npm version`. Mixing the two once sent a tag name to Datadog's repository as a branch.

The guard is pinned to one exact version, never a range: Harper runs `npm install` when it installs a component, and a range would resolve to whatever the registry held that day. `package-lock.json` has to agree with the manifest on name, version and both dependency lists, because every CI leg starts with `npm ci`; `npm version` does not keep the lock's optional dependencies in step, so run `npm install` after a bump. A test checks both.

## Tests

- `npm test`: component and e2e tiers, stubs for the binaries.
- `npm run test:windows`: the same directories through the gate, which subtracts what `windows-gate-checks.mjs` names, each with its observed failure written beside it, and refuses a run that executed nothing. Add to `EXCLUDED` only for a failure seen on Windows.
- `npm run test:binaries`: real binaries from `build/<platform>/bin`, so `npm run build-agent` first. The equivalence suite is excluded on Windows: its guard row's teardown kills agents the guard then restarts, and the runner never exits.
- `npm run test:live`: a real `harper@5.2.9`, real spans. One row boots this checkout; one boots the published package at the manifest's version from the registry, or `DD_LIVE_REGISTRY_VERSION`, and skips until that version exists; one needs `DD_LIVE_HARPER_NATIVE` set to a Harper worktree carrying `scope.processes`. `DD_LIVE_KEEP` leaves the fixture on disk. A failed boot carries the tail of `harper-run.log` and the last `DatadogStatus` in its error.

The receiver counter the live and binaries tiers read is a snapshot the trace-agent resets, and the delivery verdict trails it by the first stats bucket, about twenty seconds; `waitForDeliveredCount` latches the two apart for that reason.

## Release

A hand-pushed `v*` tag runs `build-release.yml`: four platform builds, a smoke test on each (on Windows the build tree cannot be moved aside, and the test says so and runs on), a GitHub release, then five publishes. Publishing authenticates with the job's OIDC token through a trusted publisher on each package; there is no npm token on the repository. The dist-tag is derived from the version: the prerelease identifier, or `latest`. npm 11 refuses a prerelease without one.

`verify-package.js` gates on the packed tarball rather than the working tree: both binaries in every platform package, each carrying its required symbol and free of the build tag `--build-exclude` drops.

Workflow files are parsed by GitHub before any job runs, and a checkout step whose `with:` is left empty fails every run silently in the run list. `yaml.safe_load` before pushing.

## Conventions

No dependence on any HarperFast repository or package. Commit messages, comments and docs follow `jaxontalk`: no em dashes, no triads, lead with the claim. Verify rather than assert; prefer negative tests; report failures plainly.
