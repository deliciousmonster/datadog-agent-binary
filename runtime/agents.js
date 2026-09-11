// What each Datadog process is, keyed by the filename of its binary.
//
// The key is `shipsAs`, and it is a file on disk rather than a label: runtime/binary.js builds
// `<shipsAs><.exe on win32>`, asks each platform package this host installs for exactly that name, and
// checks the basename of what comes back. Everything else in a row here is a fact about Datadog that an
// operator never chooses, which is why resources.js names the processes and this file describes them.

/** Harper's spawn name, which is also the PID-lock filename. Stated once: a second spelling is a second lock. */
const lockName = (shipsAs) =>
	shipsAs.startsWith("datadog-") ? shipsAs : `datadog-${shipsAs}`;

/**
 * @param {{ receiver: number }} ports Resolved per instance, so an exit hint names the port this node used.
 * @returns {Record<string, object>}
 */
const table = (ports) => ({
	"trace-agent": {
		kind: "trace",
		title: "trace-agent",
		// The trace-agent's `-c` takes the config FILE. Its own help text says directory and is wrong.
		args: (paths) => ["run", "-c", paths.configFile],
		exitHint: `An immediate non-zero exit from the trace-agent usually means something else already holds 127.0.0.1:${ports.receiver}.`,
	},
	"datadog-agent": {
		kind: "core",
		title: "core agent",
		// --sysprobecfgpath takes the DIRECTORY holding system-probe.yaml, where -c takes the directory
		// holding datadog.yaml; both are the runtime tree. Passed whether or not system-probe runs, because
		// the file it names is what tells this agent to stop polling a socket nothing serves.
		args: (paths) => [
			"run",
			"-c",
			paths.runtimeDir,
			"--sysprobecfgpath",
			paths.sysprobeConfigDir,
		],
	},
	"system-probe": {
		kind: "sysprobe",
		title: "system-probe",
		// Opt-in, and its binary ships in a package an operator installs by name.
		optional: true,
		enabled: (probes) => probes.systemProbe,
		// `-c` here takes the FILE, unlike the core agent's, which takes the directory.
		args: (paths) => ["run", "-c", paths.sysprobeConfigFile],
		exitHint:
			"system-probe loads eBPF programs, which needs root or CAP_SYS_ADMIN and a kernel it has an " +
			"object for. An immediate non-zero exit is usually one of those two.",
	},
	"process-agent": {
		kind: "process",
		title: "process-agent",
		optional: true,
		// Follows system-probe rather than taking a flag of its own, and this is the line most likely to be
		// "corrected" by someone reading it cold. There is no probes.processAgent, deliberately: process-agent
		// exists here to ship what system-probe collects, and on a node with no system-probe it would run the
		// same `process` and `rtprocess` checks the core agent already runs, twice. It is also the only
		// Datadog flavor whose ConnectionsCheck.IsEnabled() returns true, so it is what actually delivers
		// connection data off the box; turning it on without system-probe gives duplicate checks and no
		// connections.
		enabled: (probes) => probes.systemProbe,
		args: (paths) => [
			"--cfgpath",
			paths.runtimeDir,
			"--sysprobe-config",
			paths.sysprobeConfigFile,
		],
		exitHint:
			"process-agent is the only flavor that runs the connections check, so it needs the same " +
			"system-probe config the core agent is pointed at.",
	},
	"security-agent": {
		kind: "security",
		title: "security-agent",
		optional: true,
		enabled: (probes) => probes.security,
		// Its own config, plus the system-probe file, which is where the runtime-security socket is named.
		args: (paths) => [
			"start",
			"-c",
			paths.securityConfigFile,
			"--sysprobe-config",
			paths.sysprobeConfigFile,
		],
		exitHint:
			"security-agent's runtime security talks to system-probe over its socket, so it exits when " +
			"system-probe is not running.",
	},
});

/** Every binary this package knows how to run, for an error that can name the alternatives. */
export const KNOWN = Object.keys(table({ receiver: 0 }));

/**
 * The declared processes, in the order given, which is start order: the trace-agent comes first because it
 * owns the socket dd-trace is dialing.
 *
 * An unknown name throws here rather than resolving to nothing. A list is the whole declaration, so a typo
 * in it is a binary that silently never starts, and that is the failure mode this entire package exists to
 * remove.
 *
 * @param {readonly string[]} names
 * @param {{ receiver: number }} ports
 */
export function agentsFor(names, ports) {
	const known = table(ports);
	const unknown = names.filter((name) => !known[name]);
	if (unknown.length > 0)
		throw new Error(
			`unknown Datadog process ${unknown.map((n) => `"${n}"`).join(", ")}. ` +
				`This package ships: ${KNOWN.join(", ")}.`
		);
	return names.map((shipsAs) => ({
		shipsAs,
		name: lockName(shipsAs),
		...known[shipsAs],
	}));
}
