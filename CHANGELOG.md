# Changelog

Notable changes to `@deliciousmonster/datadog-agent-binary`. Package versions track the
Datadog Agent version they ship.

## Unreleased

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
- **API** `BinaryManager.ensureTraceAgentBinary(version?)`. `ensureBinary()` now takes
  the kind first and the version second; with no arguments it still resolves the core
  agent.
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

- `BuildResult` gained `outputPaths`, a map of binary kind to path. `outputPath` is
  unchanged and still points at the core agent. `datadog-agent-build build` prints one
  line per binary, and `install` resolves every binary the platform ships.
- `Platform` gained `getBinaries()`, `getBinary(kind)`, and `getTraceAgentBinaryName()`.
  `getBinaryName()` still returns the core agent's filename.
- Building, packaging, and runtime resolution all iterate one list of binary descriptors
  instead of each assuming a single binary.
- The npm tarball also carries `example/` (a runnable Harper v5 component that spawns
  both agents as one-per-node singletons), `CHANGELOG.md`, and `.datadog-agent-version`.
- `npm test` discovers `test/**/*.test.js` instead of naming files individually.
  `npm run test:integration` runs the Harper-backed suite under `test/integration/`.
