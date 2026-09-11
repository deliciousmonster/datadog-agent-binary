// What Datadog is on this node: the binaries, the processes, the ports they agree on, the runtime tree. One
// file, because splitting it put the port a probe reads three modules from the config line that pinned it.

import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { createBinaryResolver } from "@deliciousmonster/harper-binary-kit/resolve";
import {
	hostRoot,
	resolvePort,
	writeFiles,
} from "@deliciousmonster/harper-process-guard";

import {
	HARPER_LOG_CHECK,
	collectCoreChecks,
	removeStaleDefaults,
	renderDatadogYaml,
	renderLogSources,
	renderSecurityAgentYaml,
	renderSystemProbeYaml,
} from "./render.js";

/**
 * The five ports this node resolved, read once per component instance.
 *
 * @typedef {object} Ports
 * @property {number} receiver @property {number} expvar @property {number} debug
 * @property {number} dogstatsd @property {number} processExpvar
 */

/**
 * What an operator asked for on the opt-in half, in Datadog's own spelling.
 *
 * @typedef {object} ProbeSettings
 * @property {boolean} systemProbe @property {boolean} security
 * @property {{ discovery: boolean, networkMonitoring: boolean, serviceMonitoring: boolean }} modules
 */

/**
 * Every path under the runtime tree. One object, because the core agent takes the directory holding a file
 * and system-probe takes the file, so both spellings are stated rather than rebuilt per call site.
 *
 * @typedef {Record<string, string>} RuntimePaths
 */

/**
 * What prepareRuntime settled: the tree, the files to write into it, and what it resolved on the way.
 *
 * @typedef {object} Runtime
 * @property {string | null} root Harper's root, or null when nothing could name one.
 * @property {RuntimePaths} paths
 * @property {Record<string, string>} configFiles Absolute path to contents, written before anything spawns.
 * @property {ProbeSettings} probes
 * @property {string[]} coreChecks The checks that were collected, by name.
 */

/**
 * One declared process, as the start path hands it to a supervisor.
 *
 * @typedef {object} Agent
 * @property {string} shipsAs The binary's filename, which is what the resolver asks a platform package for.
 * @property {string} name Harper's spawn name, which is also the PID-lock filename.
 * @property {string} kind Which verifier proves this one is the agent it claims to be.
 * @property {string} title What an operator reads in a log line.
 * @property {boolean} [optional] Started only where `enabled` says so.
 * @property {(probes: ProbeSettings) => boolean} [enabled]
 * @property {(paths: RuntimePaths) => string[]} args
 * @property {string} [exitHint] What an immediate non-zero exit from this one usually means.
 */

/** How an operator reading a log knows which component is speaking. */
export const LABEL = "Datadog supervisor";

// The reaper takes its own lock beside the agents', so its name is what a second component sharing the
// directory would collide on; this one names the package rather than taking the guard's generic default.
export const REAPER_NAME = "datadog-agent-reaper";

// -- The binaries ------------------------------------------------------------------------------------------

// Constant, never derived: a deployed component's nearest package.json can carry any name, and a wrong base
// resolves a platform package that does not exist.
export const PACKAGE_NAME = "@deliciousmonster/datadog-agent-binary";

// The base package installs everywhere; the probe package is installed by name. Both are asked for every
// binary rather than routed, so one moving between them needs no change here.
const BASE = { suffix: "", optional: false };
const PROBE = {
	suffix: "-probe",
	optional: true,
	carries:
		`It is not a dependency of ${PACKAGE_NAME}, because it carries system-probe, security-agent and ` +
		`their precompiled eBPF objects and most nodes do not run them.`,
};

const resolver = createBinaryResolver({
	packageName: PACKAGE_NAME,
	// The package root, one level up: a dev checkout's build output sits beside runtime/, never inside it.
	packageRoot: `${import.meta.dirname}/..`,
	variants: [BASE, PROBE],
	buildCommand: "npm run build-agent",
	// Written here, not in the kit: a bare specifier resolves against the file the `import` is in, so the kit
	// would look for these packages beside itself.
	load: (name) => import(name),
});

/** @param {{ shipsAs: string, title?: string }} agent */
export const resolveBinary = (agent) => resolver.resolveBinary(agent);

/**
 * Where the probe package put the eBPF objects, or null when it is not installed. Asked rather than
 * computed; the accessor name comes from the directory by one rule, so it is predictable without reading it.
 */
export const resolveEbpfDir = () =>
	resolver.resolveDir(PROBE, "getShareSystemProbeDir");

// -- The ports ---------------------------------------------------------------------------------------------

/**
 * Read once per component instance, because every worker thread renders the config and probes the endpoints
 * from these numbers and a second reading could disagree with the first.
 *
 * @param {import('@deliciousmonster/harper-process-guard').Log} log
 */
/** @param {import("@deliciousmonster/harper-process-guard").Log} log @returns {Ports} */
export function resolvePorts(log) {
	const port = (/** @type {string} */ name, /** @type {number} */ fallback) =>
		resolvePort(name, fallback, log, LABEL);
	return {
		receiver: port("DD_APM_RECEIVER_PORT", 8126),
		expvar: port("DD_EXPVAR_PORT", 5000),
		debug: port("DD_APM_DEBUG_PORT", 5012),
		// Pinned for the same reason as expvar: this component sends its own process series here, so the
		// sender and the listener come from one number rather than two defaults that can drift apart.
		dogstatsd: port("DD_DOGSTATSD_PORT", 8125),
		// process-agent's own expvar, separate from the core agent's. Without it nothing on this node can
		// say whether the connections check is running, which is the only reason that binary is here.
		processExpvar: port("DD_PROCESS_CONFIG_EXPVAR_PORT", 6062),
	};
}

// -- The processes -----------------------------------------------------------------------------------------
// The key is `shipsAs`, a file on disk rather than a label.

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
		// --sysprobecfgpath takes the directory holding system-probe.yaml, passed whether or not it runs: that
		// file is what stops this agent polling a socket nothing serves.
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
		// No flag of its own, deliberately: it ships what system-probe collects, and without one it would run
		// the core agent's `process` checks twice and deliver no connections.
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
 * The declared processes in start order, the trace-agent first because it owns the socket dd-trace dials.
 * An unknown name throws: a typo in the whole declaration is a binary that silently never starts.
 *
 * @param {readonly string[]} names
 * @param {{ receiver: number }} ports
 */
/** @returns {Agent[]} */
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

// -- system-probe and security-agent -----------------------------------------------------------------------
// The opt-in half: privileged, installed by name, and loud about why it cannot start where it cannot.

/** Whether a `DD_`-style flag reads as on. Absent is off here, unlike the process series: these cost privileges. */
const on = (value) =>
	["true", "1", "yes", "on"].includes(String(value ?? "").toLowerCase());

/**
 * What an operator asked for, in Datadog's own spelling, so existing knowledge carries over. The modules are
 * separate flags: NPM tracks every connection, USM parses their traffic, and either is wanted without the other.
 */
/** @param {NodeJS.ProcessEnv} [env] @returns {ProbeSettings} */
export function probeSettings(env = process.env) {
	const systemProbe = on(env.DD_SYSTEM_PROBE_ENABLED);
	const security = on(env.DD_RUNTIME_SECURITY_CONFIG_ENABLED);
	return {
		systemProbe,
		security,
		modules: {
			// Service discovery is the one the core agent asks for on its own, so it follows system-probe
			// rather than needing a flag of its own to stop the log line this exists to fix.
			discovery:
				systemProbe &&
				!["false", "0", "no", "off"].includes(
					String(env.DD_DISCOVERY_ENABLED ?? "").toLowerCase()
				),
			networkMonitoring: systemProbe && on(env.DD_NETWORK_CONFIG_ENABLED),
			serviceMonitoring:
				systemProbe && on(env.DD_SERVICE_MONITORING_CONFIG_ENABLED),
		},
	};
}

/** Capability bit for CAP_SYS_ADMIN, which is the one every eBPF loader here needs. */
const CAP_SYS_ADMIN = 21n;
const CAP_BPF = 39n;

/**
 * Whether this process could load an eBPF program on Linux: root, or CAP_SYS_ADMIN or CAP_BPF in the CapEff
 * mask. `setcap` bridges it and runs the binary non-dumpable, which breaks its kernel-version detection.
 */
function linuxPrivilege(read, uid) {
	if (typeof uid === "function" && uid() === 0)
		return { able: true, why: "running as root" };
	let mask;
	try {
		const found = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(read());
		if (found) mask = BigInt(`0x${found[1]}`);
	} catch {
		// A kernel or container that does not publish it. Unknown is not permission.
	}
	if (mask === undefined)
		return {
			able: false,
			why: "this process is not root and its effective capabilities could not be read from /proc/self/status",
		};
	const has = (/** @type {bigint} */ bit) => (mask >> bit) & 1n;
	if (has(CAP_SYS_ADMIN) || has(CAP_BPF))
		return {
			able: true,
			why: "the effective capability set carries CAP_SYS_ADMIN or CAP_BPF",
		};
	return {
		able: false,
		why:
			`this process is not root and its effective capabilities (CapEff=0x${mask.toString(16)}) carry ` +
			"neither CAP_SYS_ADMIN nor CAP_BPF, so no eBPF program can be loaded. Run the container with " +
			"--cap-add SYS_ADMIN (and a writable /sys/fs/bpf), or leave DD_SYSTEM_PROBE_ENABLED unset",
	};
}

/**
 * The same on macOS, where the tracer captures packets rather than loading programs and needs a /dev/bpf
 * device. Answered by opening one: group membership, permissions and the sandbox all bear on it.
 */
function macosPrivilege(openBpf, uid) {
	if (typeof uid === "function" && uid() === 0)
		return { able: true, why: "running as root" };
	try {
		openBpf();
		return { able: true, why: "this process can open a /dev/bpf device" };
	} catch (error) {
		return {
			able: false,
			why:
				`this process is not root and cannot open /dev/bpf0 (${/** @type {NodeJS.ErrnoException} */ (error).code ?? /** @type {Error} */ (error).message}), so the ` +
				"packet-capture tracer has no device to read. Run as root, or add the user to the access_bpf " +
				"group, or leave DD_SYSTEM_PROBE_ENABLED unset",
		};
	}
}

/**
 * And on Windows, two signed kernel drivers from Datadog's MSI that no npm package can install. Reported
 * rather than tested: opening a device would be a side effect taken during a status read.
 */
const windowsPrivilege = () => ({
	able: null,
	why:
		"Windows system-probe reaches the kernel through the ddnpm and ddprocmon drivers, which this " +
		"package cannot install. Install them from Datadog's agent MSI; without them system-probe starts " +
		"and opens a device nothing created",
});

/**
 * Whether this host can run system-probe: three platforms, three mechanisms, and `able: null` on Windows
 * meaning unknown. Reported never enforced, so what it buys is a line rather than a restart loop.
 */
export function probePrivilege({
	read = () => readFileSync("/proc/self/status", "utf-8"),
	openBpf = () => closeSync(openSync("/dev/bpf0", "r")),
	uid = process.getuid,
	platform = process.platform,
} = {}) {
	if (platform === "linux") return linuxPrivilege(read, uid);
	if (platform === "darwin") return macosPrivilege(openBpf, uid);
	if (platform === "win32") return windowsPrivilege();
	return {
		able: false,
		why: `there is no system-probe for ${platform}`,
	};
}

/**
 * What this node resolved about the two opt-in agents and what stands in the way. Reported rather than
 * enforced: the binary is the authority, and this replaces a restart loop that named no missing capability.
 *
 * @param {ProbeSettings} probes What probeSettings() resolved from the environment.
 * @param {string | null} ebpfDir Where the precompiled objects are, or null if none were found.
 * @param {{ log: import('@deliciousmonster/harper-process-guard').Log }} context
 */
export function probeStatus(probes, ebpfDir, { log }) {
	const reasons = [];
	if (probes.systemProbe) {
		const privilege = probePrivilege();
		// `able: null` is Windows, unknown rather than refused. Still a blocker: an operator who has not
		// installed the drivers needs to read it.
		if (privilege.able !== true) reasons.push(privilege.why);
		if (!ebpfDir)
			reasons.push(
				`no precompiled eBPF objects were found: ${PACKAGE_NAME}-probe-<platform> is what ships them, ` +
					"and without it system-probe starts, answers `version`, and loads not one program"
			);
		for (const reason of reasons)
			log.warn(`${LABEL}: DD_SYSTEM_PROBE_ENABLED is set and ${reason}`);
	}
	return {
		...probes,
		ebpfDir,
		// Empty means nothing known stands in the way, which is not the same as a running probe. The
		// process's own verified verdict is what says that, and it is reported beside this.
		blockers: reasons,
	};
}

// -- The runtime tree ---------------------------------------------------------------------------------------
// Where every file the agents read is written, and the one call that renders them.

// The runtime tree lives under Harper's root, never the component directory, which `harper deploy` replaces
// under a live agent. Named by the component's own directory, not just "datadog": sharing one pidDir means sharing one lock.
/**
 * @param {string} componentDir
 * @param {{ ports: Ports, log: import("@deliciousmonster/harper-process-guard").Log, ebpfDir: string | null }} context
 * @returns {Runtime}
 */
export function prepareRuntime(componentDir, { ports, log, ebpfDir }) {
	const root = hostRoot(log, LABEL);
	const runtimeDir = root
		? join(root, "datadog", basename(componentDir))
		: join(homedir(), ".harper-datadog", basename(componentDir));
	const paths = {
		runtimeDir,
		configFile: join(runtimeDir, "datadog.yaml"),
		confd: join(runtimeDir, "conf.d"),
		run: join(runtimeDir, "run"),
		authToken: join(runtimeDir, "run", "auth_token"),
		ipcCert: join(runtimeDir, "run", "ipc_cert.pem"),
		coreLog: join(runtimeDir, "logs", "agent.log"),
		traceLog: join(runtimeDir, "logs", "trace-agent.log"),
		sysprobeLog: join(runtimeDir, "logs", "system-probe.log"),
		securityLog: join(runtimeDir, "logs", "security-agent.log"),
		processLog: join(runtimeDir, "logs", "process-agent.log"),
		// The core agent takes `--sysprobecfgpath <directory>` and system-probe takes `-c <file>`, so both
		// spellings of the same file are stated here rather than rebuilt at each call site.
		sysprobeConfigDir: runtimeDir,
		sysprobeConfigFile: join(runtimeDir, "system-probe.yaml"),
		securityConfigFile: join(runtimeDir, "security-agent.yaml"),
		// Runtime security's rule policies, under the runtime tree rather than the stock install's
		// /etc/datadog-agent/runtime-security.d, which the harperdb user cannot create.
		securityPolicies: join(runtimeDir, "runtime-security.d"),
		// Under the runtime tree, never /var/run/datadog: that is the stock install's path and does not
		// exist beside a component, which is the same reason dogstatsd_socket and receiver_socket are empty.
		sysprobeSocket: join(runtimeDir, "run", "sysprobe.sock"),
		securitySocket: join(runtimeDir, "run", "runtime-security.sock"),
		// Not Harper's own pids/: the guard's reaper stops every guard-written lock it finds in the directory
		// it watches, and a shared one would hold locks this component never wrote.
		pidDir: join(runtimeDir, "pids"),
		reaperLog: join(runtimeDir, "logs", "reaper.log"),
	};
	mkdirSync(paths.run, { recursive: true });
	mkdirSync(dirname(paths.coreLog), { recursive: true });
	mkdirSync(paths.confd, { recursive: true });
	mkdirSync(paths.pidDir, { recursive: true });
	// Created either way: an enabled engine pointed at a missing directory logs `error while loading
	// policies` every start, where an empty one correctly means "no custom rules".
	mkdirSync(paths.securityPolicies, { recursive: true });

	const probes = probeSettings();
	const configFiles = {
		[paths.configFile]: renderDatadogYaml(paths, ports),
		// Written whether or not either agent runs. Off, this file is what stops the core agent polling a
		// socket nothing serves; on, it is where the socket and the eBPF objects are named.
		[paths.sysprobeConfigFile]: renderSystemProbeYaml(paths, probes, ebpfDir),
		[paths.securityConfigFile]: renderSecurityAgentYaml(paths, probes),
	};
	let checks = [];
	try {
		checks = collectCoreChecks(join(componentDir, "conf.d"));
		for (const check of checks) {
			configFiles[join(paths.confd, check.dir, "conf.yaml.default")] =
				check.body;
		}
		const owned = new Set(checks.map((check) => check.dir));
		// Harper's own log and the agents', written whenever the root is known. Tailed only under
		// DD_LOGS_ENABLED=true, so off this file costs nothing.
		if (root) {
			configFiles[join(paths.confd, HARPER_LOG_CHECK, "conf.yaml.default")] =
				renderLogSources(join(root, "log", "hdb.log"), paths, REAPER_NAME);
			owned.add(HARPER_LOG_CHECK);
		}
		removeStaleDefaults(paths.confd, owned);
	} catch (error) {
		log.warn(
			`${LABEL}: no core check configuration was collected (${/** @type {Error} */ (error).message}), so the agent ` +
				`will report healthy and collect no host metrics. Traces are unaffected.`
		);
	}

	return {
		root,
		paths,
		configFiles,
		probes,
		coreChecks: checks.map((check) => check.name),
	};
}

/** Write the rendered files where every worker thread writes them. */
export const writeConfigFiles = (configFiles, log) =>
	writeFiles(configFiles, log, LABEL);

// -- Where they serve --------------------------------------------------------------------------------------
// Stated once, so a verifier, the probe blocklist and a status read cannot name different ports or schemes.

/** The trace-agent's APM receiver. A receiver that does not advertise /v0.4/traces is not one dd-trace can use. */
export const receiverInfoUrl = (port) => `http://127.0.0.1:${port}/info`;

/** The core agent's expvar, and process-agent's, which is the same shape on its own port. */
export const expvarUrl = (port) => `http://127.0.0.1:${port}/debug/vars`;

/** The trace-agent's own expvar. https, because it serves it under the self-signed IPC certificate. */
export const debugVarsUrl = (port) => `https://127.0.0.1:${port}/debug/vars`;
