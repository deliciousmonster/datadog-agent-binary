# AGENTS.md

For whoever changes this repository. `README.md` is for whoever installs it.

## Layout

Three directories and one file at the root, and the split is what each half needs.

`runtime/` is what the tarball ships. Plain ESM, no build, six files.

- `resources.js`: 14 lines. The process names and the compartment globals, and nothing else. Harper compiles only this file, so the constrained `spawn` and `logger` are read here and handed down; a module that imports them itself gets the unconstrained ones. A test holds it to 25 lines of code, because it was 535 once.
- `runtime/datadog.js`: what Datadog is on this node. The platform packages that carry the binaries, the process table keyed by binary filename, the five ports, the runtime tree. `PACKAGE_NAME` is a literal, never derived, because a deployed component's nearest `package.json` can carry any name.
- `runtime/render.js`: every file the agents read, as pure string production over its arguments. It resolves no path, reads no environment variable and polls nothing, so a renderer cannot become a config that depends on a running agent.
- `runtime/verify.js`: what separates "the process is up" from "the process is the agent this node needs". Called by the start path and by `test/binaries/smoke.js`, which is why it is not inside `component.js`.
- `runtime/delivery.js`: whether anything reached Datadog, read as three hops that prove nothing about each other. Called by the status endpoint and by the soak.
- `runtime/series.js`: what the processes cost, as a named series something can alert on.
- `runtime/component.js`: the lifecycle that joins them. Start what `datadog.js` describes, hold one start per node, answer `/DatadogStatus/`. Supervision is `@deliciousmonster/harper-process-guard`'s `supervisorFor`, which takes Harper's `scope.processes` where a build carries it and the guard's own path otherwise.

Everything about supervising a process rather than about Datadog is in the guard: the lock, the reaper, the pollers, Harper's root path, the port reader, the per-thread claim, the verdict staleness. Everything about packaging a binary is in `@deliciousmonster/harper-binary-kit`: staging, the publish gate, the symbol floors, the dist-tags, and the resolver `datadog.js` calls.

`agent-build/` is Datadog's own build, which is the half only this repo can do. Plain ESM with `// @ts-check` and JSDoc, nothing compiled. `cli.js` is the entry, `agent.js` the sequence, `compile.js` the Go build, `extract.js` the lift out of the signed .deb, `verify-release.js` the trust chain, `release.js` the pins, `binaries.js` the descriptors, `toolchain.js` the targets, `tree.js` the build tree. Not in the tarball; it needs `dda`, `go` and `pip`.

`binary-kit.config.js` is what this package publishes, declared once. The kit reads it for staging, the gate, `optionalDependencies` and the release. Before it those were four statements of one fact in four files.

`conf.d/`, `config.yaml` ship as written; the core checks ship or the core agent reports healthy and collects nothing.

## Nothing compiles

There is no `dist/`, and the reason is worth keeping. `src/` used to be TypeScript compiled into one, and fourteen files reached into that output: four scripts, nine suites, the release workflow. Six npm scripts opened with `npm run build` to keep it fresh, and a stale one measured nothing three separate times in one week.

`tsconfig.json` emits nothing and checks everything that ships, including `test/`. The old one included `src/**` only, so `runtime/` - the half Harper actually runs - was checked by nothing at all, and that is the gap a `standDownFor` calling an unimported `existsSync` went through: every default-prefix start threw `ReferenceError` inside `scheduleSeries`, `createStart`'s catch swallowed it into `status.error`, and every test passed because each one injected its own `stat`.

The guard and the kit are read through `maxNodeModuleJsDepth`, so their JSDoc is their types. A `.d.ts` here would be a second, drifting copy of modules this repo does not own.

## Versions

The package version is the Datadog version it pins in `.datadog-agent-version`, with a prerelease identifier of its own: `7.82.1-next.0`. A test holds the numeric core to the pin. The build reads the pin; the tag's version reaches only `npm version`. Mixing the two once sent a tag name to Datadog's repository as a branch.

The guard and the kit are pinned to exact versions, never ranges: Harper runs `npm install` when it installs a component, and a range would resolve to whatever the registry held that day. `package-lock.json` has to agree with the manifest on name, version and both dependency lists, because every CI leg starts with `npm ci`; `npm version` does not keep the lock's optional dependencies in step, so run `npm install` after a bump. A test checks both.

## Tests

Five tiers, named for what a suite needs rather than for how important it sounds.

- `test/unit/`: spawns nothing, plants nothing. `npm test` runs it.
- `test/system/`: starts a real process, plants a real package in `node_modules`, or drives a real tracer. `npm test` runs it too.
- `test/binaries/`: real binaries from `build/<platform>/bin`, so `npm run build-agent` first. `npm run test:binaries`.
- `test/live/`: a real `harper@5.2.9`, real spans. `npm run test:live`. One row boots this checkout; one boots the published package at the manifest's version from the registry, or `DD_LIVE_REGISTRY_VERSION`, and skips until that version exists; one needs `DD_LIVE_HARPER_NATIVE` set to a Harper worktree carrying `scope.processes`. `DD_LIVE_KEEP` leaves the fixture on disk. A failed boot carries the tail of `harper-run.log` and the last `DatadogStatus` in its error.
- `test/soak/soak.mjs`: a long run against a real container. Steady load on the shop, chaos on a randomly staggered schedule (agent and reaper kills, restarts with Harper's pid files seeded to pid 1, a SIGSTOP, a `docker pause`, a 10x burst, a wrong API key across a recreate), and one status row a minute from the agents' intake counters and container resource use. `SOAK_HOURS`, `SOAK_RPS`, `SOAK_GAP_MIN`, `SOAK_SKIP`, `SOAK_KEY_MIN`, `SOAK_OUT` shape it; the header comment shows a six-minute smoke.

`npm run test:windows` is the Windows leg's stand-in for `npm test`: the same two directories through `test/windows-gate.mjs`, minus the suites `test/windows-gate-checks.mjs` names, each with its observed failure written beside it, and it refuses a run that executed nothing. Add to `EXCLUDED` only for a failure seen on Windows. Every entry there names a suite from `test/system/`, which is the tier split saying something true: the fixture that cannot be an executable on Windows and the teardown that races a restart are both properties of running something for real.

The receiver counter the live and binaries tiers read is a snapshot the trace-agent resets, and the delivery verdict trails it by the first stats bucket, about twenty seconds; `waitForDeliveredCount` latches the two apart for that reason.

## Harper's own pid files

Harper's sandboxed `spawn` keeps `<root>/pids/<name>.pid` per process name and, when that file names a
pid that answers `kill(pid, 0)`, hands the pid back instead of spawning. After a restart the kernel
reissues pids and a thread of Harper itself answers for one: on 2026-09-08 a stock container reported
three started agents that were three threads of pid 1. `clearStaleHostPidFiles` removes such a file
before the guard asks Harper to spawn, when the pid it names is running something other than the
process; the guard refuses a handed-back pid it cannot identify, so the two together fail loud rather
than supervise a stranger.

## system-probe and security-agent

Both are wired and both are off by default. `DD_SYSTEM_PROBE_ENABLED=true` and
`DD_RUNTIME_SECURITY_CONFIG_ENABLED=true` turn them on, in Datadog's own spelling rather than a name this
package invented. `DD_NETWORK_CONFIG_ENABLED` and `DD_SERVICE_MONITORING_CONFIG_ENABLED` gate NPM and USM
separately, because NPM watches every connection on the host and USM parses their traffic; either can be
wanted without the other, and Datadog leaves both off too.

Off is the default here and on is the default for the process series, and the asymmetry is deliberate.
These cost privileges: system-probe loads eBPF programs, which needs root or CAP_SYS_ADMIN and an object
matching the running kernel. `probePrivilege()` in `runtime/datadog.js` reads `CapEff` out of
`/proc/self/status` and reports what is missing at WARN, rather than letting the supervisor restart a
process that exits every time with `operation not permitted`. It reports; it does not refuse. The binary is
the authority on what it can do.

The binaries come from the probe platform package, which is not installed by default, and the eBPF objects
come with them. `resolveEbpfDir()` asks that package where they landed and the answer is written into
`system_probe_config.bpf_dir`. The accessor name is derived from the directory by one rule, so
`share/system-probe` gives `getShareSystemProbeDir` and a caller writes it without reading the staged
package first. Without it system-probe starts, answers `version`, and loads not one program, which is the
worst outcome available because everything downstream then reports healthy.

`runtime/render.js` writes `system-probe.yaml` on every start whether or not either agent runs, and that
file is also the fix for the log noise below. The core agent is passed `--sysprobecfgpath <runtimeDir>`,
system-probe `-c <runtimeDir>/system-probe.yaml`, and security-agent both its own config and
`--sysprobe-config`, so all three read one file and cannot disagree about the socket.

## Known log noise, and its cause

The core agent logged `failed to get services: Get "http://sysprobe/debug/stats"` about once a minute
whenever `process_config.process_collection.enabled` was on. It was ours, not Datadog's: the workloadmeta
process collector asks system-probe for service discovery, and this build shipped no system-probe. Live
Processes itself worked; only the discovery half of the collector had nothing to talk to.

The gate is `discovery.enabled`, and the part that made it hard to reach is that the collector reads that
key out of the *system-probe* config rather than the core agent's
(`comp/core/workloadmeta/collectors/internal/process/process_collector.go:191` at 7.82.1, via
`serviceDiscoveryEnabled(systemProbeConfig)`). Writing `/etc/datadog-agent/system-probe.yaml` is not a
route inside the stock Harper image, because the `harperdb` user cannot create that directory. What is a
route is `--sysprobecfgpath`, which takes the directory to read it from, so the file now lives in the
runtime tree beside `datadog.yaml` and says `discovery.enabled: false` on any node that is not running
system-probe. `DD_DISCOVERY_ENABLED` still overrides it, since the environment outranks the file.

Nothing else logs at ERROR in steady state. Measured after a restart on 2026-09-09: the trace-agent and
the reaper logged nothing at ERROR or WARN, and the core agent logged only this and a Kubelet fallback
probe on a host that is not Kubernetes.

## Release

A hand-pushed `v*` tag runs `build-release.yml`: four platform builds, a smoke test on each (on Windows the build tree cannot be moved aside, and the test says so and runs on), a GitHub release, then a call to the kit's reusable workflow for everything else. Staging, the symbol floors, the gate, the publish and the dist-tag move are the kit's, driven off `binary-kit.config.js`, so the package list, the CI matrix and the pinned `optionalDependencies` cannot disagree.

The build uploads `bin-<platform>` and `share-<platform>`, which are the names the kit's workflow reads back. Publishing authenticates with the job's OIDC token through a trusted publisher on each package. `dist-tag add` is the one step OIDC has not covered in practice, so `NPM_TOKEN` is passed for that alone and the step fails with the exact commands when neither works.

The publish gate reads the packed tarball rather than the working tree: every binary a package declares, each carrying its `requiredSymbol`, plus `binary-kit.config.js`'s own `check` hook, which reads the Go build-tag record off the artifact and refuses a binary carrying the tag `--build-exclude` drops. A symbol says what a binary was built WITH; only that check says what it was built WITHOUT.

## Where the binaries come from, and which package carries them

Two of the five are compiled here and three are lifted out of Datadog's own signed .deb. `agent-build/binaries.js`
says which in each descriptor's `from` field, and that one field drives the build loop, the extraction
step, the packaging and the publish gate.

The core agent is built because only it links `libdatadog-agent-rtloader`, and building it is how the
embedded Python runtime gets excluded. The trace-agent is built because this package exists to fix the
trace-agent, and lifting it would trade that provenance for nothing: stripped, ours is 23,066,288 bytes
against Datadog's 23,017,272, a difference of 0.2%. system-probe, process-agent and security-agent are
lifted because building system-probe needs a kernel-header tree matched to every target an operator might
run, which is why Datadog precompiles 26 eBPF objects and ships 42 MB of them.

`agent-build/extract.js` refuses to write a byte until the whole apt trust chain holds: Datadog's key signed
`Release`, `Release` gives the SHA256 of the `Packages` index, `Packages` gives the SHA256 of the .deb, and
the download matches the SHA256 pinned in `agent-build/release.js`. Verified end to end against the live repository
on 2026-09-10. gpg's home goes under the system temp directory rather than the build tree, because
gpg-agent's socket path is capped at 104 bytes on macOS and a deep checkout makes gpg report a broken agent
rather than a long path.

`binary-kit.config.js` splits the result across two npm packages per platform. The base package
(`-<platform>`) carries the built binaries and stays an optionalDependency, so every install gets it. The
probe package (`-probe-<platform>`) carries the lifted ones and is deliberately not an optionalDependency:
npm installs an optionalDependency on every host whose os and cpu match, and charging 145 MB to nodes that
never turn system-probe on is the cost the split refuses. An operator who wants them installs one by name.
The eBPF objects ride with the Linux probe packages alone, declared through `extraDirs`' `onlyOn`: macOS
captures packets and Windows uses kernel drivers, so shipping objects to either would be 42 MB neither can
load. The resolver asks both packages for every binary, and reports an absent probe package as the opt-in it
is rather than as a broken install.

### What a node needs before system-probe can load a program

Proven on a live container 2026-09-10, kernel 6.12.76-linuxkit aarch64, with all three modules
(`network_tracer`, `event_monitor`, `discovery`) started from the objects this package extracts. Four
things are required and each one failed first in a way that named something else:

1. **The two binaries on `applications.allowedSpawnCommands`.** Harper's sandboxed spawn refuses anything
   not listed, and the refusal reads `Command ... is not allowed`. Four entries now, not two.
2. **The container's capabilities, held effectively rather than in the bounding set.** `--cap-add` puts
   them in the bounding set; a process running as uid 1000 still has `CapEff: 0`. `setcap` on the binary
   bridges that and costs something: a binary with file capabilities runs non-dumpable, `/proc/self/mem`
   becomes unreadable, and system-probe's kernel-version detection fails with `permission denied`. Running
   the container as root is the route that works, and it is what Datadog's own agent container does.
3. **debugfs or tracefs mounted.** `-v /sys/kernel/debug:/sys/kernel/debug` at `docker run`; a mount made
   inside a running container does not survive `docker restart`.
4. **The eBPF objects owned by root.** system-probe refuses an object it does not trust, reporting
   `has incorrect permissions: user=502, group=20`. An npm install performed as a non-root user leaves
   them owned by that user and every module fails to load with the objects sitting right there.

None of those four is this package's to fix, and all four are its to state, because each one produces a
running system-probe that loads nothing while everything downstream reports healthy.

Windows is the exception the descriptor states rather than hides. security-agent exists there and Datadog
ships it inside an MSI, so `buildOn: ["windows"]` builds it on that leg instead of lifting it out of a
Debian package it cannot come from.

Workflow files are parsed by GitHub before any job runs, and a checkout step whose `with:` is left empty fails every run silently in the run list. `yaml.safe_load` before pushing. A reusable workflow is resolved only under `.github/workflows/` of the repository that owns it.

## Conventions

No dependence on any HarperFast repository or package. Commit messages, comments and docs follow `jaxontalk`: no em dashes, no triads, lead with the claim. Verify rather than assert; prefer negative tests; report failures plainly.
