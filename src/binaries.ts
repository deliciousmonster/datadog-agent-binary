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
	/** Symbol that must be present in the shipped binary. MOD-3 gates publish on it. */
	readonly requiredSymbol: string;
	/** Symbol whose presence means a shipping constraint was violated. MOD-3 gates on it. */
	readonly forbiddenSymbol?: string;
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
		forbiddenSymbol: "datadog-agent/pkg/collector/python",
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
