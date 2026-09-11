// @ts-check
/** @typedef {import("./toolchain.js").OS} OS */
/** @typedef {import("./toolchain.js").Target} Target */
/** @typedef {"build" | "release"} BinarySource */

/**
 * One binary this package ships.
 *
 * @typedef {object} AgentBinary
 * @property {string} shipsAs Name the binary ships under, before the platform's executable suffix.
 * @property {BinarySource} from Where this binary comes from.
 *
 *   `build` compiles it from the pinned Datadog source. `release` lifts it out of Datadog's own signed
 *   package, verified through the chain in verify-release.js.
 *
 *   The split is not a preference, it is what each binary needs. Measured 2026-09-10 against
 *   `datadog-agent_7.82.1-1_arm64.deb`: only the core `agent` links `libdatadog-agent-rtloader`, so only
 *   that one has to be built here to get a Python-free binary. Everything else links neither rtloader nor
 *   libpython and runs relocated to a bare path in a container that never built it.
 *
 *   The trace-agent stays a build anyway, and the numbers are why. Stripped, this package's trace-agent is
 *   23,066,288 bytes against Datadog's 23,017,272, a difference of 49 KB or 0.2%. There is nothing to gain
 *   by lifting a binary this package already reproduces, and the trace-agent is the one it exists to fix,
 *   so its provenance is worth keeping.
 *
 *   system-probe and security-agent are the opposite case. Building system-probe needs a Python 3.12 base
 *   for dda, lxml headers, bazelisk under that exact name, and a kernel-header tree matched to the target,
 *   because the eBPF objects have to match the kernels an operator runs. That is why Datadog precompiles
 *   26 of them and ships them at 42 MB, and it is not reproducible on a build runner in any useful sense.
 * @property {readonly OS[]} [buildOn] Systems that build this one whatever `from` says.
 *
 *   The extraction source is a Debian package, so `from: "release"` is a statement about Linux and cannot
 *   be one about anything else. security-agent exists on Windows and Datadog ships it there inside an MSI,
 *   which is a second extraction format for one binary. Building it there is the cheaper answer and it is
 *   the answer this package already had, so the Windows capability is kept rather than quietly dropped
 *   because the Linux route does not reach it.
 * @property {boolean} [optional] Whether this binary ships in the opt-in probe package rather than the base one.
 *
 *   Separate from `from`, and the two were conflated once. The split used to key on where a binary came
 *   from, because on Linux the lifted pair and the opt-in pair happened to be the same two binaries. They
 *   are answers to different questions: `from` is where the bytes come from, and this is whether an
 *   operator has to ask for them. system-probe and security-agent are opt-in because of what they are -
 *   privileged, and inert until a host is configured for them - not because of where they were built. Key
 *   the split on source and a Windows system-probe, which is built rather than lifted, lands in the base
 *   package and is installed on every Windows node that wanted neither.
 * @property {string} task Invoke task that builds it. Meaningless for a `release` binary.
 * @property {string} builtAt Path under the source tree the task writes to, before the platform's
 *   executable suffix.
 * @property {readonly string[]} mandatoryArgs Flags encoding a shipping constraint. Always passed, never
 *   overridable.
 * @property {string} argsOverride Environment variable supplying extra flags, so CI can iterate without a
 *   code change.
 * @property {string} requiredSymbol Symbol that must be present in the shipped binary. The publish gate
 *   reads the packed tarball for it.
 * @property {string} [forbiddenBuildTag] Go build tag mandatoryArgs excludes. The publish gate reads the
 *   shipped binary's build info and refuses its presence.
 * @property {readonly OS[]} [onlyOn] Systems this binary exists on. Absent means all of them.
 *
 *   Not every agent binary is cross-platform. system-probe is eBPF and Linux is where it does anything:
 *   `tasks/system_probe.py::build()` opens with `if not is_macos: build_object_files(ctx)`, so a macOS
 *   build produces a binary with no probes in it. security-agent's runtime security is likewise Linux and
 *   Windows. Shipping an inert binary would be worse than shipping none, because a platform package that
 *   carries it implies the capability is there.
 */

/**
 * Where one binary comes from on one system, which `buildOn` can override per system. @param {AgentBinary}
 * binary @param {Pick<Target, "os">} target @returns {BinarySource}
 */
export const sourceOf = (binary, target) =>
	binary.buildOn?.includes(target.os) ? "build" : binary.from;

/**
 * The binaries this package compiles for one system. @param {Pick<Target, "os">} target @returns {readonly
 * AgentBinary[]}
 */
export const builtFor = (target) =>
	binariesFor(target).filter((b) => sourceOf(b, target) === "build");

/**
 * The binaries this package lifts out of Datadog's signed release for one system. @param {Pick<Target, "os">}
 * target @returns {readonly AgentBinary[]}
 */
export const extractedFor = (target) =>
	binariesFor(target).filter((b) => sourceOf(b, target) === "release");

/**
 * The binaries the base package carries: what every install gets. @param {Pick<Target, "os">} target @returns
 * {readonly AgentBinary[]}
 */
export const baseBinaries = (target) =>
	binariesFor(target).filter((b) => !b.optional);

/**
 * The binaries the opt-in probe package carries, which an operator installs by name. @param {Pick<Target,
 * "os">} target @returns {readonly AgentBinary[]}
 */
export const probeBinaries = (target) =>
	binariesFor(target).filter((b) => b.optional);

/**
 * The binaries that exist for one system, which is not always all of them. @param {Pick<Target, "os">} target
 * @returns {readonly AgentBinary[]}
 */
export function binariesFor(target) {
	return BINARIES.filter((b) => !b.onlyOn || b.onlyOn.includes(target.os));
}

/** @type {readonly AgentBinary[]} */
export const BINARIES = [
	{
		shipsAs: "datadog-agent",
		from: "build",
		task: "agent.build",
		builtAt: "bin/agent/agent",
		// Python and rtloader cost every integration and the `system.processes.*` family, which runtime/series.js
		// produces from /proc instead; --no-enable-bazel is measured, its default filled a 14 GB runner.
		mandatoryArgs: [
			// Only python: systemd rode in on this flag with no measurement recorded, and excluding it cost
			// the journald log source and the systemd integration.
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
		// Empty: TRACE_AGENT_TAGS carries neither, and trace_agent.py::build() has no rtloader parameter, so
		// forwarding the core agent's excludes is rejected rather than ignored.
		mandatoryArgs: [],
		argsOverride: "DD_TRACE_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/trace/api.",
	},
	{
		shipsAs: "system-probe",
		from: "release",
		task: "system-probe.build",
		builtAt: "bin/system-probe/system-probe",
		// Static Go with eBPF, needing neither python nor rtloader. Dropped as collateral in `0c52271`, which
		// left the core agent's workloadmeta collector asking a socket nothing serves once a minute.
		mandatoryArgs: [],
		argsOverride: "DD_SYSTEM_PROBE_BUILD_ARGS",
		optional: true,
		requiredSymbol: "datadog-agent/cmd/system-probe",
		// Every system, by three mechanisms: eBPF objects on Linux, tracer_darwin.go's packet capture on
		// macOS, and the ddnpm/ddprocmon drivers on Windows, which arrive in Datadog's MSI.
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
		// The shipper for what system-probe collects: net.go:136's IsEnabled() returns false for every other
		// flavor, so without it the eBPF programs collect into a queue nothing drains.
		buildOn: ["macos", "windows"],
	},
	{
		shipsAs: "security-agent",
		from: "release",
		task: "security-agent.build",
		builtAt: "bin/security-agent/security-agent",
		// One argv entry, not two: security_agent.py:50 takes build_tags as a positional, which invoke spells
		// `--build-tags=value`, and split in two it reads the second as another task name.
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

/**
 * The Go build tags recorded in a linked binary, or null when it carries no build-info record at all. @param
 * {Buffer} bytes @returns {string[] | null}
 */
export function recordedBuildTags(bytes) {
	const at = bytes.indexOf(TAGS_LINE);
	if (at === -1) return null;
	const from = at + TAGS_LINE.length;
	const end = bytes.indexOf(0x0a, from);
	return bytes
		.subarray(from, end === -1 ? bytes.length : end)
		.toString("latin1")
		.split(",");
}

/**
 * The name a binary is shipped and copied under for one target, e.g. `datadog-agent.exe`. @param {AgentBinary}
 * binary @param {Target} target @returns {string}
 */
export function binaryFilename(binary, target) {
	return `${binary.shipsAs}${target.exe}`;
}
