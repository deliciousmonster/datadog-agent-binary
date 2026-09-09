import { Target } from "./targets.js";

export interface AgentBinary {
	/** Name the binary ships under, before the platform's executable suffix. */
	readonly shipsAs: string;
	readonly task: string;
	/** Path under the source tree the task writes to, before the platform's executable suffix. */
	readonly builtAt: string;
	/** Flags encoding a shipping constraint. Always passed, never overridable. */
	readonly mandatoryArgs: readonly string[];
	/** Environment variable supplying extra flags, so CI can iterate without a code change. */
	readonly argsOverride: string;
	/** Symbol that must be present in the shipped binary. scripts/verify-package.js gates publish on it. */
	readonly requiredSymbol: string;
	/** Go build tag mandatoryArgs excludes. scripts/verify-package.js reads the shipped binary's build info and gates on its absence. */
	readonly forbiddenBuildTag?: string;
}

export const BINARIES: readonly AgentBinary[] = [
	{
		shipsAs: "datadog-agent",
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
		// `runtime/process-metrics.js` produces the same named, aggregated, alertable series from `/proc` and
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
			"--build-exclude=systemd,python",
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
		task: "trace-agent.build",
		builtAt: "bin/trace-agent/trace-agent",
		// Deliberately empty. TRACE_AGENT_TAGS carries neither python nor systemd, and
		// tasks/trace_agent.py::build() has no rtloader parameter, so forwarding the core agent's
		// excludes is rejected rather than ignored.
		mandatoryArgs: [],
		argsOverride: "DD_TRACE_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/trace/api.",
	},
];

// Go writes the tag set it linked with into the binary's own build info as one comma-separated line, so
// the exclusion is read off the artifact instead of trusting the flag the build was asked to use.
const TAGS_LINE = Buffer.from("build\t-tags=", "latin1");

/** The Go build tags recorded in a linked binary, or null when it carries no build-info record at all. */
export function recordedBuildTags(bytes: Buffer): string[] | null {
	const at = bytes.indexOf(TAGS_LINE);
	if (at === -1) return null;
	const from = at + TAGS_LINE.length;
	const end = bytes.indexOf(0x0a, from);
	return bytes
		.subarray(from, end === -1 ? bytes.length : end)
		.toString("latin1")
		.split(",");
}

/** The name a binary is shipped and copied under for one target, e.g. `datadog-agent.exe`. */
export function binaryFilename(binary: AgentBinary, target: Target): string {
	return `${binary.shipsAs}${target.exe}`;
}
