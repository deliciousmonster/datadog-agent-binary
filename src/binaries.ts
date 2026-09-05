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
		// A relocatable npm artifact and Python integrations are mutually exclusive. The python tag
		// links an embedded CPython and rpaths librtloader into the build tree, and --exclude-rtloader
		// keeps get_build_flags from baking that RPATH in; --no-enable-bazel stops the rtloader
		// install's bazel default extracting an LLVM toolchain that fills a 14 GB runner.
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
