export interface AgentBinary {
	/** Name the binary ships under, before the platform's executable suffix. */
	readonly shipsAs: string;
	/** Invoke task, and the directory under the source tree it writes into. */
	readonly task: string;
	readonly builtIn: string;
	readonly builtAs: string;
	readonly args: readonly string[];
	/** Environment variable overriding `args`, so CI can iterate without a code change. */
	readonly argsOverride: string;
	/** Symbol that must be present in the shipped binary, asserted at publish. */
	readonly requiredSymbol: string;
}

export const BINARIES: readonly AgentBinary[] = [
	{
		shipsAs: "datadog-agent",
		task: "agent.build",
		builtIn: "bin/agent",
		builtAs: "agent",
		// The python tag rpaths librtloader and an embedded CPython into the build tree, so the binary
		// only runs on the machine that built it. Excluding the tag still runs the rtloader install,
		// whose bazel default extracts an LLVM toolchain that fills a 14 GB runner, hence the other two.
		args: [
			"--build-exclude=systemd,python",
			"--exclude-rtloader",
			"--no-enable-bazel",
		],
		argsOverride: "DD_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/aggregator",
	},
	{
		shipsAs: "trace-agent",
		task: "trace-agent.build",
		builtIn: "bin/trace-agent",
		builtAs: "trace-agent",
		// Deliberately empty. trace-agent.build has no rtloader parameter, so forwarding the core
		// agent's excludes is rejected rather than ignored.
		args: [],
		argsOverride: "DD_TRACE_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/trace/api.",
	},
];
