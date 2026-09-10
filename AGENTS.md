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

- `test/soak/soak.mjs`: a long run against a real container. Steady load on the shop, chaos on a randomly staggered schedule (agent and reaper kills, restarts with Harper's pid files seeded to pid 1, a SIGSTOP, a `docker pause`, a 10× burst, a wrong API key across a recreate), and one status row a minute from the agents' intake counters and container resource use. `SOAK_HOURS`, `SOAK_RPS`, `SOAK_GAP_MIN`, `SOAK_SKIP`, `SOAK_KEY_MIN`, `SOAK_OUT` shape it; the header comment shows a six-minute smoke.

The receiver counter the live and binaries tiers read is a snapshot the trace-agent resets, and the delivery verdict trails it by the first stats bucket, about twenty seconds; `waitForDeliveredCount` latches the two apart for that reason.

## Harper's own pid files

Harper's sandboxed `spawn` keeps `<root>/pids/<name>.pid` per process name and, when that file names a
pid that answers `kill(pid, 0)`, hands the pid back instead of spawning. After a restart the kernel
reissues pids and a thread of Harper itself answers for one: on 2026-09-08 a stock container reported
three started agents that were three threads of pid 1. `clearStaleHarperPidFiles` removes such a file
before the guard asks Harper to spawn, when the pid it names is running something other than the
process; the guard refuses a handed-back pid it cannot identify, so the two together fail loud rather
than supervise a stranger.

## Known log noise, and its cause

The core agent logs `failed to get services: Get "http://sysprobe/debug/stats"` about once a minute
whenever `process_config.process_collection.enabled` is on. It is ours, not Datadog's: the workloadmeta
process collector asks system-probe for service discovery
(`comp/core/workloadmeta/collectors/internal/process/process_collector.go:556` at 7.82.1), and this
build excludes system-probe. Live Processes itself works; only the discovery half of the collector has
nothing to talk to.

The gate is `discovery.enabled` in the *system-probe* config, which defaults on. Turning it off needs
either `DD_DISCOVERY_ENABLED=false` in the node's environment, which the agents inherit from Harper, or
a per-agent `env` threaded through the guard's process descriptors, which the guard does not carry
today. Writing `/etc/datadog-agent/system-probe.yaml` is not a route inside the stock Harper image: the
`harperdb` user cannot create that directory.

Nothing else logs at ERROR in steady state. Measured after a restart on 2026-09-09: the trace-agent and
the reaper logged nothing at ERROR or WARN, and the core agent logged only this and a Kubelet fallback
probe on a host that is not Kubernetes.

## Release

A hand-pushed `v*` tag runs `build-release.yml`: four platform builds, a smoke test on each (on Windows the build tree cannot be moved aside, and the test says so and runs on), a GitHub release, then the publishes. Publishing authenticates with the job's OIDC token through a trusted publisher on each package; there is no npm token on the repository. The dist-tag is derived from the version: the prerelease identifier, or `latest`. npm 11 refuses a prerelease without one.

`verify-package.js` gates on the packed tarball rather than the working tree: every binary a package declares, each carrying its required symbol and free of the build tag `--build-exclude` drops, plus the eBPF objects wherever system-probe ships.

## Where the binaries come from, and which package carries them

Two of the four are compiled here and two are lifted out of Datadog's own signed .deb. `src/binaries.ts`
says which in each descriptor's `from` field, and that one field drives the build loop, the extraction
step, the packaging and the publish gate.

The core agent is built because only it links `libdatadog-agent-rtloader`, and building it is how the
embedded Python runtime gets excluded. The trace-agent is built because this package exists to fix the
trace-agent, and lifting it would trade that provenance for nothing: stripped, ours is 23,066,288 bytes
against Datadog's 23,017,272, a difference of 0.2%. system-probe and security-agent are lifted because
building system-probe needs a kernel-header tree matched to every target an operator might run, which is
why Datadog precompiles 26 eBPF objects and ships 42 MB of them.

`src/extract.ts` refuses to write a byte until the whole apt trust chain holds: Datadog's key signed
`Release`, `Release` gives the SHA256 of the `Packages` index, `Packages` gives the SHA256 of the .deb, and
the download matches the SHA256 pinned in `src/release.ts`. Verified end to end against the live repository
on 2026-09-10. gpg's home goes under the system temp directory rather than the build tree, because
gpg-agent's socket path is capped at 104 bytes on macOS and a deep checkout makes gpg report a broken agent
rather than a long path.

`src/packages.ts` splits the result across two npm packages per platform. The base package
(`-<platform>`) carries the built binaries and stays an optionalDependency, so every install gets it. The
probe package (`-probe-<platform>`) carries the lifted ones plus the eBPF objects and is deliberately not
an optionalDependency: npm installs an optionalDependency on every host whose os and cpu match, and
charging 145 MB to nodes that never turn system-probe on is the cost the split refuses. An operator who
wants them installs one by name. `runtime/binary.js` asks both packages for every binary, and reports an
absent probe package as the opt-in it is rather than as a broken install.

Windows is the exception the descriptor states rather than hides. security-agent exists there and Datadog
ships it inside an MSI, so `buildOn: ["windows"]` builds it on that leg instead of lifting it out of a
Debian package it cannot come from. Windows therefore publishes no probe package.

Two package names are new and have no npm trusted publisher yet:
`@deliciousmonster/datadog-agent-binary-probe-linux-x86_64` and `-probe-linux-arm64`. npm answers a first
publish to a name with no trusted publisher with a 404, so create both before the next `v*` tag.

Workflow files are parsed by GitHub before any job runs, and a checkout step whose `with:` is left empty fails every run silently in the run list. `yaml.safe_load` before pushing.

## Conventions

No dependence on any HarperFast repository or package. Commit messages, comments and docs follow `jaxontalk`: no em dashes, no triads, lead with the claim. Verify rather than assert; prefer negative tests; report failures plainly.
