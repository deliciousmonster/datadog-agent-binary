/** Where one binary comes from on one system, which `buildOn` can override per system. */
export const sourceOf = (binary, target) => binary.buildOn?.includes(target.os) ? "build" : binary.from;
/** The binaries this package compiles for one system. */
export const builtFor = (target) => binariesFor(target).filter((b) => sourceOf(b, target) === "build");
/** The binaries this package lifts out of Datadog's signed release for one system. */
export const extractedFor = (target) => binariesFor(target).filter((b) => sourceOf(b, target) === "release");
/** The binaries the base package carries: what every install gets. */
export const baseBinaries = (target) => binariesFor(target).filter((b) => !b.optional);
/** The binaries the opt-in probe package carries, which an operator installs by name. */
export const probeBinaries = (target) => binariesFor(target).filter((b) => b.optional);
/** The binaries that exist for one system, which is not always all of them. */
export function binariesFor(target) {
    return BINARIES.filter((b) => !b.onlyOn || b.onlyOn.includes(target.os));
}
export const BINARIES = [
    {
        shipsAs: "datadog-agent",
        from: "build",
        task: "agent.build",
        builtAt: "bin/agent/agent",
        // These three cost every Python integration and the `system.processes.*` family, and only the last
        // of them rests on a measurement.
        //
        // --no-enable-bazel is the measured one: the rtloader install's bazel default extracts an LLVM
        // toolchain that filled a 14 GB runner.
        //
        // The other two came from upstream `@harperfast/datadog-agent-binary`, `src/builders/base.ts`: "by
        // default the agent is built with the embedded Python runtime, which makes the binary dynamically
        // link `libdatadog-agent-rtloader` (and an embedded interpreter) by an rpath pointing into the build
        // tree. That binary does NOT run on any machine other than the build server - it can't find those
        // libraries." The diagnosis is right and the conclusion does not follow: it cannot find them because
        // they were not shipped with it.
        //
        // Read at 7.82.1: `pkg/collector/python/init.go`'s resolvePythonHome() computes
        // the Python home relative to the binary's own location (`../embedded3`, or `../../embedded`) and
        // uses it whenever that directory exists, falling back to the ldflags value only when it does not.
        // The agent is written to be moved, and Datadog's own .deb/.rpm/.dmg ship exactly that way: the
        // binary with an `embedded/` directory beside it. A platform package carrying `bin/` plus
        // `embedded/` is the same shape, and npm's os/cpu matching already delivers it.
        //
        // What is real is the RPATH: `tasks/libs/common/utils.py:349` bakes -Wl,-rpath,<builder path> for
        // librtloader. That is what $ORIGIN and @loader_path exist for, and get_build_flags takes an
        // explicit python_home_3 so the link-time default need not be inferred from the build tree either.
        // Tested 2026-09-09 against Datadog's own `datadog-agent_7.82.1-1_arm64.deb`, which ships this exact
        // shape. Its RPATH is `/opt/datadog-agent/embedded/lib`, an absolute install path rather than a build
        // tree. Copied to `/app/node_modules/@x/dd` in a container that never built it: bare, it fails with
        // `libdatadog-agent-rtloader.so: cannot open shared object file`, which is the symptom upstream
        // described. With `LD_LIBRARY_PATH` pointed at the shipped `embedded/lib`, the same binary reports
        // `Agent 7.82.1`, logs `Using '/app/node_modules/@x/dd/embedded' as Python home`, and the Python
        // `process` check emits `system.processes.mem.rss`, `.number`, `.open_file_descriptors` and the rest.
        //
        // So the exclusion cannot be justified by portability. It is justified by not needing it. The one
        // thing Python bought that a Harper node wants is the `system.processes.*` family, and
        // `runtime/component.js` produces the same named, aggregated, alertable series from `/proc` and
        // `process.memoryUsage()` in the runtime Harper already ships. What is left behind is the
        // integrations-core long tail -- Postgres, Redis, nginx -- which a node running Harper does not run,
        // and OpenMetrics scraping, which nothing here asks for. Paying 634 MB per platform for that would be
        // buying the ecosystem to get one metric family we already have.
        //
        // This is settled, and the reason is worth keeping straight: the premise was wrong, and the decision
        // is right anyway. If the integrations ecosystem is ever actually wanted, the mechanics are proven
        // and the cost is 634 MB per platform, most of it 325 MB of `embedded/bin` and 247 MB of
        // `embedded/lib`, on top of the 173 MB this ships today.
        //
        // Upstream scoped it honestly, "sufficient for the log/metric forwarding use case", and left an
        // escape hatch: its getAgentBuildArgs() returns DD_AGENT_BUILD_ARGS wholesale, with a note that the
        // right flag "varies by dda/invoke version". This package ships APM too, and it removed the hatch:
        // buildArgs() appends the override to these rather than replacing them, and verify-package.js
        // refuses to publish a binary carrying the python tag. A scoped workaround became enforced policy.
        //
        // Independent of all of it: system-probe needs neither. tasks/system_probe.py builds it static Go
        // with eBPF and no rtloader, so shipping it does not wait on this question.
        mandatoryArgs: [
            // Only python. systemd rode in on this flag with no measurement or test recorded for it, and
            // excluding it costs the journald log source and the systemd integration. Python is settled on
            // its own terms; systemd never had terms.
            "--build-exclude=python",
            "--exclude-rtloader",
            "--no-enable-bazel",
        ],
        argsOverride: "DD_AGENT_BUILD_ARGS",
        requiredSymbol: "datadog-agent/pkg/aggregator",
        // Not a symbol: pkg/collector/python compiles either way (version_nopy.go is //go:build
        // !python), so its package path is in a correct build and only the tag set discriminates.
        forbiddenBuildTag: "python",
    },
    {
        shipsAs: "trace-agent",
        from: "build",
        task: "trace-agent.build",
        builtAt: "bin/trace-agent/trace-agent",
        // Deliberately empty. TRACE_AGENT_TAGS carries neither python nor systemd, and
        // tasks/trace_agent.py::build() has no rtloader parameter, so forwarding the core agent's
        // excludes is rejected rather than ignored.
        mandatoryArgs: [],
        argsOverride: "DD_TRACE_AGENT_BUILD_ARGS",
        requiredSymbol: "datadog-agent/pkg/trace/api.",
    },
    {
        shipsAs: "system-probe",
        from: "release",
        task: "system-probe.build",
        builtAt: "bin/system-probe/system-probe",
        // Needs neither python nor rtloader: tasks/system_probe.py calls get_build_flags without them and
        // adds osusergo/netgo/static. It was dropped from this package in `0c52271`, a commit that replaced a
        // hand-written build with upstream's and deleted the `go build -o build/system-probe` line in the
        // same diff, with no evaluation recorded. Without it the core agent's workloadmeta collector asks a
        // socket nothing serves and logs it once a minute, which is what this node has been reporting all
        // day.
        mandatoryArgs: [],
        argsOverride: "DD_SYSTEM_PROBE_BUILD_ARGS",
        optional: true,
        requiredSymbol: "datadog-agent/cmd/system-probe",
        // Every system, and by three different mechanisms. Recorded as Linux-only once, on an inference
        // that turned out to be wrong on both of the others.
        //
        // Linux: eBPF, loaded from the 26 precompiled objects the probe package ships.
        //
        // macOS: no eBPF at all, so the absence of objects there costs nothing. `pkg/network/tracer/
        // tracer_darwin.go` is a full Tracer with DNS and connection tracking, and
        // `connection/ebpfless_tracer_darwin.go` is the packet-capture source under it; traceroute states
        // outright that no driver is needed. The earlier note here read a skipped `build_object_files` as a
        // binary with no probes in it, which is true only where the probes are eBPF. Built rather than
        // lifted, because the extraction source is a Debian package.
        //
        // Windows: two signed kernel drivers rather than eBPF. `pkg/network/driver/handle.go:26` opens
        // `\\.\ddnpm` and `pkg/windowsdriver/procmon/procmon.go:51` opens `\\.\ddprocmon`. Those arrive in
        // Datadog's MSI and install as kernel drivers, which needs administrator rights and a signature
        // chain no npm package can satisfy, so the binary ships and the drivers are the operator's step.
        // That is the same division as Linux, where the capabilities and mounts are the operator's too.
        buildOn: ["macos", "windows"],
    },
    {
        shipsAs: "process-agent",
        from: "release",
        task: "process-agent.build",
        builtAt: "bin/process-agent/process-agent",
        mandatoryArgs: [],
        argsOverride: "DD_PROCESS_AGENT_BUILD_ARGS",
        requiredSymbol: "datadog-agent/cmd/process-agent",
        optional: true,
        // The shipper for everything system-probe collects, and the reason it is here at all. The core
        // agent runs the `process` and `rtprocess` checks itself, so Live Processes needs nothing extra,
        // but the connections check refuses to run anywhere else: `IsEnabled()` in
        // pkg/process/checks/net.go:136 opens with `if flavor.GetFlavor() != flavor.ProcessAgent return
        // false`, before it looks at network_config.enabled at all. Measured on a live node 2026-09-10:
        // system-probe had network_tracer loaded and the core agent reported `Connections Queue length: 0`
        // and `Connections Bytes enqueued: 0`. eBPF programs collecting into nothing.
        //
        // Lifted on Linux and built elsewhere, the same split as system-probe and for the same reason: the
        // extraction source is a Debian package.
        buildOn: ["macos", "windows"],
    },
    {
        shipsAs: "security-agent",
        from: "release",
        task: "security-agent.build",
        builtAt: "bin/security-agent/security-agent",
        // `tasks/security_agent.py::build()` takes `build_tags` as a required positional, not as flags the
        // way the other three do, so this is the one descriptor whose args are a value rather than options.
        // One argument, not two. `def build(ctx, build_tags, ...)` at tasks/security_agent.py:50 makes
        // build_tags a required positional, and invoke spells a positional as `--build-tags=value`. Sent as
        // two argv entries, invoke reads the second as another task name and answers `No idea what
        // 'sysprobe_bundle' is!`, which reads as a bad tag rather than as a split argument.
        mandatoryArgs: ["--build-tags=sysprobe_bundle"],
        argsOverride: "DD_SECURITY_AGENT_BUILD_ARGS",
        requiredSymbol: "datadog-agent/cmd/security-agent",
        // Runtime security is a Linux and Windows product; there is no macOS build of it to ship.
        onlyOn: ["linux", "windows"],
        // Lifted on Linux, built on Windows. Datadog ships the Windows one inside an MSI, and reading an MSI
        // is a second extraction format for a single binary; the build already works there.
        optional: true,
        buildOn: ["windows"],
    },
];
// Go writes the tag set it linked with into the binary's own build info as one comma-separated line, so
// the exclusion is read off the artifact instead of trusting the flag the build was asked to use.
const TAGS_LINE = Buffer.from("build\t-tags=", "latin1");
/** The Go build tags recorded in a linked binary, or null when it carries no build-info record at all. */
export function recordedBuildTags(bytes) {
    const at = bytes.indexOf(TAGS_LINE);
    if (at === -1)
        return null;
    const from = at + TAGS_LINE.length;
    const end = bytes.indexOf(0x0a, from);
    return bytes
        .subarray(from, end === -1 ? bytes.length : end)
        .toString("latin1")
        .split(",");
}
/** The name a binary is shipped and copied under for one target, e.g. `datadog-agent.exe`. */
export function binaryFilename(binary, target) {
    return `${binary.shipsAs}${target.exe}`;
}
//# sourceMappingURL=binaries.js.map