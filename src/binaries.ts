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
		// Excluding python drops the cgo rtloader bridge, which is the one dependency
		// that makes the binary non-relocatable off the machine that built it.
		args: ["--build-exclude=systemd,python"],
		argsOverride: "DD_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/aggregator",
	},
];
