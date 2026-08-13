# Changelog

Notable changes to `@deliciousmonster/datadog-agent-binary`. Package versions track the
Datadog Agent version they ship.

## Unreleased

### Added: the trace-agent (APM receiver)

The package now builds, packages, and ships the Datadog **trace-agent** alongside the
core agent. The trace-agent is the process that binds `127.0.0.1:8126` and receives
spans from `dd-trace`.

Before this change only the core agent was built and published. `dd-trace` in a
consuming application would create spans, flush them to `127.0.0.1:8126`, get
`ECONNREFUSED`, and drop every span without logging anything. Metrics and logs worked,
APM was empty, and no error appeared anywhere. Confirmed against the published artifact:
`strings` on `package/bin/datadog-agent` found no symbols for `pkg/trace/api`,
`pkg/trace/agent`, `pkg/trace/writer`, or `cmd/trace-agent`.

**Required consumer action: allowlist a second path.** Under Harper v5 the trace-agent
is a second spawn and needs its own entry in `applications.allowedSpawnCommands`.
Upgrading without adding it reproduces the original symptom exactly. The core agent
starts, metrics and logs keep flowing, the trace-agent spawn is rejected, and traces
stay missing with nothing visibly broken.

```yaml
applications:
  allowedSpawnCommands:
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/datadog-agent
    - /app/node_modules/@deliciousmonster/datadog-agent-binary-linux-x86_64/bin/trace-agent # new
```

Resolve the exact paths with `BinaryManager.ensureBinary()` and
`BinaryManager.ensureTraceAgentBinary()`. The match is an exact string compare against
the first space-delimited token of the command, so the path must be absolute and must
not contain a space. The allowlist is read once at module load, so Harper needs a
restart after the edit.

What is new:

- **Binary:** `trace-agent` (`trace-agent.exe` on Windows) in every platform package,
  next to the existing `datadog-agent`.
- **Accessor:** `getTraceAgentBinaryPath()`, exported by each platform package
  alongside `getBinaryPath()`. Platform packages also export a `binaries` map of kind
  to filename.
- **Command:** `datadog-trace-agent`, a new `bin` entry that resolves and runs the
  trace-agent.
- **API:** `BinaryManager.ensureTraceAgentBinary(version?)`. `ensureBinary()` now takes
  the binary kind as its first argument and the version as its second;
  `ensureBinary()` with no arguments still resolves the core agent.
- **Harper spawn name:** `datadog-trace-agent`, distinct from the core agent's
  `datadog-agent`. Harper's dedupe is an exclusive PID-file lock keyed on that name, so
  two names give one core agent and one trace-agent per node instead of one process
  total.
- **Build:** `dda --no-interactive inv trace-agent.build` runs as a second target. It
  takes no `--build-exclude` flags; `TRACE_AGENT_TAGS` includes neither `python` nor
  `systemd`, and the task is a plain `go_build` with no rtloader or CPython.
  `DD_TRACE_AGENT_BUILD_ARGS` overrides its flags, mirroring `DD_AGENT_BUILD_ARGS`.
- **Packaging:** platform packages are written all-or-nothing. A platform whose build
  is missing either binary is skipped rather than published with a partial `bin/`.
- **CI:** both binaries are smoke-tested standalone and checked against the glibc floor
  (the trace-agent's `netcgo` tag makes it dynamically linked too), and a new job starts
  the trace-agent, confirms `/info` advertises `/v0.4/traces`, and posts a trace payload
  to the running receiver.

### Added: launcher diagnostics for APM

Both launchers share one implementation and now report the APM environment
(`DD_APM_ENABLED`, `DD_APM_RECEIVER_PORT`, `DD_TRACE_AGENT_URL`) at startup, since a
mismatch between the port the receiver binds and the URL the tracer dials drops every
span with no error on either side.

The trace-agent launcher additionally:

- checks the config file before spawning. When a config flag was passed, a missing file
  (the agent would exit with `unable to load Datadog config file`) or an unwritable
  directory (the agent would hang 30 seconds, then fail on its auth token) is fatal and
  names the offending path. With no config flag the path is inferred from the binary's
  own location — the trace-agent derives its default from `InstallPath`, not from the
  core agent's `/etc/datadog-agent` — and a failed check only warns, because refusing on
  an inferred path would block launches that would have worked;
- exits 0 when a receiver is already listening on the port, rather than starting a
  second one that would die on `EADDRINUSE`;
- warns when `DD_API_KEY` is missing. A keyless trace-agent still binds and still
  accepts spans, and only the intake discards them, so the application sees successful
  flushes and Datadog shows nothing.

### Fixed: the bundled Datadog Agent version was floating

With no `--datadog-version`, the build called `getLatestVersion()` and shipped whatever
upstream had released that day. Nothing compared the result against anything, which is
how a package published as `7.75.5` came to contain agent `7.79.2`.

- The upstream release is now pinned in `.datadog-agent-version` at the repo root, read
  by `src/downloader.ts` and shipped in the npm tarball. It is the default; `latest` is
  reachable only by asking for it explicitly, and doing so warns.
- The pin used to be duplicated as a `DATADOG_AGENT_VERSION` env in
  `.github/workflows/build-release.yml`. Two copies of a pin are two pins. The workflow
  now reads the file.
- A tag that does not exist upstream fails before the clone, naming the real tags in
  that series, instead of surfacing as `Failed to download source: Not Found`.
- A clone that lands on a different ref than requested is fatal rather than a reason to
  retry via tarball, so a mislabelled artifact cannot be produced silently.
- `datadog-agent-build version` reports the pinned version first, since that is the one
  a build will actually use.

### Changed

- `BuildResult` gained `outputPaths`, a map of binary kind to path. `outputPath` is
  unchanged and still points at the core agent. `datadog-agent-build build` prints one
  line per binary produced, and `datadog-agent-build install` resolves every binary the
  platform ships rather than only the core agent.
- The npm tarball now also carries `example/` (a runnable Harper v5 component with a
  supervisor that spawns both agents as one-per-node singletons), `CHANGELOG.md`, and
  `.datadog-agent-version`.
- `npm test` discovers `test/**/*.test.js` instead of naming files one at a time, so a
  new test file runs without a `package.json` edit. `npm run test:integration` runs the
  Harper-backed suite under `test/integration/` against a real `harper` process.
- `Platform` gained `getBinaries()`, `getBinary(kind)`, and
  `getTraceAgentBinaryName()`. `getBinaryName()` is unchanged and still returns the core
  agent's filename.
- Building, packaging, and runtime resolution all iterate one list of binary descriptors
  instead of each assuming a single binary.
