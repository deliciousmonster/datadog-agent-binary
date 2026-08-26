# Changelog

Notable changes to `@deliciousmonster/datadog-agent-binary`. Entries are keyed by the
Datadog Agent release they ship, with the package version second.

The two numbers are independent. Mirroring them holds only while exactly one package ever
ships per agent release, and packaging fixes go out while the agent pin stands still.
Forcing them together is what produced a package published as `7.75.5`, a string matching
no upstream Datadog tag, carrying agent `7.79.2`.

The agent version is a shipped fact, not a version claim. `.datadog-agent-version` holds
the pin and is listed in `files[]`, so it lands in the installed tree and can be read
directly:

```bash
cat node_modules/@deliciousmonster/datadog-agent-binary/.datadog-agent-version
```

## Agent 7.82.1 (package 1.0.0, unreleased)

### Added: `conf.d/`, without which the agent collected no host metric

The package shipped binaries and one conf.d entry, the Harper log source. Every core check
is compiled into the core agent, but the collector schedules only what `conf.d` names, so
the agent ran none of them. Against 7.82.1 with the old tree, `configcheck` printed nothing
and `check cpu` answered `no valid check found`.

Nothing looked wrong from either end. `datadog.agent.running` is appended by the aggregator
on every flush rather than collected from a check, so the forwarder kept posting `202
Accepted` on `/api/intake/metrics/v3/series` for payloads holding no `system.*` series at
all.

`conf.d/` now carries a `<check>.d/conf.yaml.default` for `cpu`, `memory`, `uptime`, `load`,
`io`, `disk`, `file_handle` and `network`, and `example/dd-supervisor.js` copies them into
the runtime tree beside the log source. `.default` is upstream's own extension: the file
provider reads it as a check to run by default, and drops it whenever a plain `conf.yaml`
for the same check sits beside it, which is where an operator's settings go.

`ntp` is left out although upstream enables it. It reaches a public NTP pool every fifteen
minutes and reports `CRITICAL` when that egress is blocked, which is the normal case in a
container, about a clock the container cannot set.

### Changed: the package version line restarts at 1.0.0

The npm version moves on packaging changes and says nothing about the agent inside.
`7.75.5` was invented on the HarperFast line and matches no upstream Datadog tag; nothing
has been published under `@deliciousmonster`, so the reset strands no consumer.
`scripts/update-optional-deps.js` derives the four `optionalDependencies` pins from the
root version, and `test/e2e/platform-packages.test.js` fails if they drift.

### Changed: the bundled agent moves 7.79.1 → 7.82.1

`.datadog-agent-version` now pins 7.82.1, the current upstream release. The pin is
deliberate, not floating: see the version-pinning entry below for why `latest` is
reachable only by asking for it.

### Added: the build refuses a mismatched Go toolchain

Upstream pins the compiler it tests against in `.go-version`, and nothing here read it.
Three build paths had therefore drifted to three different compilers at once:

| path | Go used | source asked for |
| --- | --- | --- |
| CI (`GO_VERSION`) | 1.25.8 | 1.25.10 |
| local build | whatever was on `PATH` | 1.25.10 |

That is how a package built from 1.25.10-pinned source came to ship a `go1.26.4` binary,
the same class of silent drift as the floating agent version. `AgentBuilder` now reads
`.go-version` from the cloned source before building:

- A **minor** mismatch is fatal and names both versions, because Go's runtime and crypto
  defaults move between minors.
- A **patch** gap warns and continues, since upstream floats those.
- A source shipping no `.go-version` has no opinion and is not blocked, so old tags still
  build.

`GO_VERSION` in both workflows moves 1.25.8 → 1.26.5 to match what 7.82.1 pins. It stays
a literal because `setup-go` runs before the agent source is cloned; the guard above is
what makes a stale copy fail loudly instead of silently building on the wrong compiler.

### Changed: a trace launch that never binds the receiver now fails (breaking)

`trace-agent run` used to report success whenever the process started. Nothing checked
afterwards, so an agent that started and bound nothing produced
`child process started (pid=N)`, then silence, then every span dropped. That is the defect
this package exists to fix, with green output.

Measured against the shipped 7.82.1 binary: `DD_APM_ENABLED=false` makes `trace-agent run`
exit 0 having bound nothing, and an invalid `DD_APM_RECEIVER_PORT` leaves it alive and
unbound. Both are now caught.

The launcher polls the receiver's `/info` for up to 30 seconds after the spawn. If it never
answers, the failure names the port and the config path, the agent this launch started is
stopped, and the exit code is 1. A trace-agent that exits 0 without ever having answered is
also a failure, because the exit code alone cannot tell that from a clean shutdown after an
hour of serving spans. It does not touch the core agent, and a `version` or `--help`
invocation is classified as a query rather than a launch.

Related, and in the same failure class:

- `DD_APM_RECEIVER_PORT` is validated. A value that is not a port in 1-65535 still falls
  back to 8126, and now says so; `0` is passed through, because upstream reads it as "serve
  no HTTP receiver" and rewriting it points every probe at a port nothing was told to bind.
- A crash or an OOM kill exits `128 + signum` rather than 0. `SIGTERM`, `SIGINT` and
  `SIGHUP` are still a clean stop.
- `ENOEXEC` and `EACCES` from the spawn name the architecture or the missing exec bit
  instead of arriving as a bare "failed to execute".

`example/dd-supervisor.js` reports `receiverBound` per agent, so `/DatadogStatus/` answers
whether APM is served rather than whether `spawn` threw. A failure to render the optional
logs template no longer stops both agents from launching.

### Changed: TypeScript 7

`typescript` 5.9 → 7.0, `prettier` 3.6 → 3.9, `lint-staged` 16 → 17. All dev-only, and
after the entry below there is no runtime dependency left for them to sit beside.

TypeScript 7 no longer auto-includes every package under `node_modules/@types`, so
`tsconfig.json` now names `"types": ["node"]`. Without it the entire Node global surface
(`process`, `console`, `node:*`) is invisible and the build fails with TS2591 on the
first `process` reference.

`@types/node` deliberately stays on the 22 line rather than moving to 26. The engines
floor is `^22.18.0 || >=24.0.0`, and typing against Node 26 would let code that calls
APIs absent from Node 22.18 compile clean and fail at runtime for a consumer on the
version we advertise. The types track the floor, not the newest release.

`lint-staged` 17 requires Node `>=22.22.1`, above our `^22.18.0` floor. That constrains
contributors only, never consumers, since it never enters the published tarball.

### Removed: `install -v <version>` and `BinaryManager`'s `version` argument (breaking)

Neither ever selected anything. The argument reached exactly one place, a second
candidate at `build/<version>-<platform>/<name>` in the build-from-source fallback, and
no builder, script, or workflow has ever written that layout: `cli.js build` compiles
into `build/<platform>/bin`, and that is what the packaging script and both build
workflows read back out. On the path that does resolve, the packaged platform package,
the version was ignored outright, so `datadog-agent-build install -v 7.79.1` advertised a
selection it could not perform.

`.datadog-agent-version` is the pin, and it is the only one. `ensureBinary(kind?)` and
`ensureTraceAgentBinary()` now take no version; passing one is ignored in JavaScript and
a compile error in TypeScript. `install -v` exits non-zero as an unknown option.

### Removed: `commander`, the last runtime dependency

`dependencies` is now empty. `src/cli.ts` parses with `node:util` `parseArgs`, stable on
both engines the package supports, so installing this package adds the two platform
binaries and nothing else to a consumer's tree.

Every subcommand, flag, short form, help screen, and exit code is unchanged. Only the
wording of two errors moves, from commander's phrasing to Node's:

```
error: unknown option '--nope'                        → error: Unknown option '--nope'
error: too many arguments for 'install'. …            → error: Unexpected argument '7.79.2'. …
```

The typed `BuildOptions` and `InstallOptions` interfaces are gone with it. They existed
because commander hands `.action()` an `any`, and a hand-written mirror of the flag table
is a second place to forget an edit. `parseArgs` derives the value types from the option
table itself, so a flag's type cannot drift away from the call site that reads it.

### Removed: `--build-args`, `BuildOptions.buildArgs`, `BuildConfig.buildArgs` (breaking)

The flag was parsed and stored, and nothing ever read it: build args resolve per
binary from the descriptor or its `DD_AGENT_BUILD_ARGS` / `DD_TRACE_AGENT_BUILD_ARGS`
override. Removed rather than wired up, because one global arg set applied to both
binaries is the failure the per-binary descriptors exist to prevent. Passing
`--build-args` now exits non-zero instead of being ignored, and a TypeScript consumer
passing `buildArgs` to `buildForCurrentPlatform()` gets a compile error rather than a
silently dropped property. Use the env vars.

### Removed: `DatadogAgentBuilder.getLatestVersion()` (breaking)

A passthrough with no caller. `DatadogAgentDownloader.getLatestVersion()` is public and
is what the CLI already used.

### Changed: unknown positional arguments are now an error (breaking)

The commander upgrade turns excess arguments into a non-zero exit on every subcommand.
`datadog-agent-build install 7.79.2` used to ignore the argument and install the current
platform; it now fails and tells you so.

### Changed: the package is ESM-only (breaking)

`package.json` now declares `"type": "module"` and `dist/` is compiled as ES modules.
Every known consumer is an ESM Harper component and is unaffected: the exports map,
`main`, the bin names, and the engines floor are all unchanged.

- **`require()` keeps working on the supported engines.** Node loads an ES module with
  a synchronous module graph through `require()` across the whole engines floor
  (`^22.18.0 || >=24.0.0`), so a CommonJS consumer such as the Harper server still gets
  the full named API. A unit test `require()`s the built entry point on every run, so
  the graph going asynchronous breaks CI instead of a consumer.
- **The platform packages are untouched and stay CommonJS.** Their manifests carry no
  `"type"` field, nothing about them is republished, and the main package keeps loading
  them via `await import()`, so an already-installed platform package keeps resolving
  under this version.

### Added: the trace-agent (APM receiver)

Every platform package now ships the Datadog **trace-agent** next to the core agent.
The trace-agent is the process that binds `127.0.0.1:8126` and receives spans from
`dd-trace`. Before this change only the core agent was built and published, so a
consuming application created spans, flushed them into a closed port, and dropped every
one without logging anything: metrics and logs worked, APM was empty, and no error
appeared anywhere.

**Required consumer action: allowlist a second path.** Under Harper v5 the trace-agent
is a second spawn and needs its own entry in `applications.allowedSpawnCommands`.
Upgrading without adding it reproduces the original symptom exactly.

```yaml
applications:
  allowedSpawnCommands:
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent # new
```

Get the exact paths from `BinaryManager.ensureBinary()` and
`ensureTraceAgentBinary()`. The match is an exact string compare against the first
space-delimited token, so the path must be absolute and must not contain a space, and
the allowlist is read once at module load, so Harper needs a restart after the edit.

New surface:

- **Binary** `trace-agent` (`trace-agent.exe` on Windows) in every platform package.
- **Accessor** `getTraceAgentBinaryPath()`, alongside `getBinaryPath()`. Platform
  packages also export a `binaries` map of kind to filename.
- **Command** `datadog-trace-agent`, which resolves and runs it.
- **API** `BinaryManager.ensureTraceAgentBinary()`. `ensureBinary()` takes the binary
  kind; with no arguments it still resolves the core agent.
- **Harper spawn name** `datadog-trace-agent`, distinct from the core agent's
  `datadog-agent`. Harper's dedupe is a PID-file lock keyed on that name, so two names
  give one core agent and one trace-agent per node rather than one process total.
- **Build** `dda --no-interactive inv trace-agent.build` runs as a second target with no
  `--build-exclude` flags; `DD_TRACE_AGENT_BUILD_ARGS` overrides them, mirroring
  `DD_AGENT_BUILD_ARGS`.
- **Packaging** is all-or-nothing. A platform whose build is missing either binary is
  skipped rather than published with a partial `bin/`.
- **CI** smoke-tests both binaries standalone, checks both against the glibc floor, and
  starts the trace-agent to confirm `/info` advertises `/v0.4/traces` and that a posted
  trace payload is accepted.

### Added: launcher diagnostics

Both launchers share one implementation and report the APM environment
(`DD_APM_ENABLED`, `DD_APM_RECEIVER_PORT`, `DD_TRACE_AGENT_URL`) at startup, since a
mismatch between the port the receiver binds and the URL the tracer dials drops every
span with no error on either side.

The trace-agent launcher also checks its config before spawning. With an explicit config
flag, a missing file (`unable to load Datadog config file`) or an unwritable directory (a
30 second hang, then an auth-token failure) is fatal and names the path; with an inferred
path it only warns. It exits 0 when a receiver is already listening rather than starting
a second one that would die on `EADDRINUSE`, and warns when `DD_API_KEY` is missing,
because a keyless trace-agent still binds and still accepts spans while the intake
discards them.

### Fixed: the bundled Datadog Agent version was floating

With no `--datadog-version` the build shipped whatever upstream had released that day,
unchecked, which is how a package published as `7.75.5` came to contain agent `7.79.2`.

- The upstream release is pinned in `.datadog-agent-version` at the repo root, read by
  the downloader and shipped in the npm tarball. `latest` is reachable only by asking for
  it explicitly, and doing so warns. The workflow reads the same file instead of keeping
  a second copy of the pin in its env.
- A tag that does not exist upstream fails before the clone, naming the real tags in that
  series, instead of surfacing as `Failed to download source: Not Found`.
- A clone that lands on a different ref than requested is fatal, so a mislabelled
  artifact cannot be produced silently.
- `datadog-agent-build version` reports the pinned version first.

### Changed

- `BuildResult` reports build output through `outputPaths`, a map of binary kind to
  path. `datadog-agent-build build` prints one line per binary, and `install` resolves
  every binary the platform ships.
- `Platform` gained `getBinaries()` and `getBinary(kind)`, the descriptor list that
  building, packaging, and runtime resolution all iterate instead of each assuming a
  single binary.
- `dist/index.js` exports a named public API (`BinaryManager`,
  `DatadogAgentDownloader`, `createBuilder`, `Platform`, and the public types) instead
  of six `export *`, so a future internal helper cannot become public surface by
  omission. Symbols the wildcards used to expose (the launcher, the logger, the per-OS
  builder classes, `SUPPORTED_PLATFORMS`) are reachable only inside this repo.
- The npm tarball also carries `CHANGELOG.md` and `.datadog-agent-version`. The
  runnable Harper v5 example (a component that spawns both agents as one-per-node
  singletons) stays in the repository under `example/`, linked from the README; it is
  not shipped in the tarball.
- `npm test` discovers `test/**/*.test.js` instead of naming files individually.
  `npm run test:integration` runs the Harper-backed suite under `test/integration/`.

### Removed

Nothing below had ever been published, so no consumer can be depending on it. The
removals are recorded because earlier drafts of these notes promised that some of
these names would survive.

- `BuildResult.outputPath`. `outputPaths` is the only build-output surface; reading
  `.outputPath` in JS now yields `undefined`.
- `Platform.getBinaryName()` and `getTraceAgentBinaryName()`. Filenames come from the
  descriptors: `getBinary(kind).outputName`.
- The `install --force` flag, which logged a line and changed no control flow.
- `BinaryManager.createBinaryWrapper()`, `createBinaryWrappers()`, and
  `installForCurrentPlatform()`. The wrapper-generation chain was reachable from
  nothing; the committed `bin/` launchers are what the package ships.
- `PACKAGE_SCOPE`, which nothing but its own definition referenced.
