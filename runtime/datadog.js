// What Datadog is on this node: the binaries, the processes that run them, the ports they agree on, and the
// runtime tree every file is written into. One file, because there is one answer to "what did this node tell
// the agents" and splitting it put the port a probe reads three modules away from the config line that
// pinned it.
//
// The files themselves are rendered in runtime/render.js, which is pure over its arguments and which this
// file is the only caller of. Nothing here reads anything back. That is runtime/component.js, which imports
// what it needs from this file and nothing the other way: a renderer that polled would be a config file that
// depends on a running agent.

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
 * Every path this node writes or reads under the runtime tree. One object, because the core agent takes the
 * directory holding a file and system-probe takes the file, so both spellings of one path are stated rather
 * than rebuilt per call site.
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

// The base package is an optionalDependency and is there on every install. The probe package is not: it
// carries system-probe, security-agent and 42 MB of eBPF objects, and an operator installs it by name when
// they want them. Both are asked for every binary rather than routed by name, so a binary that moves between
// the two does not need this file changed.
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
	// Written here rather than inside the kit: a bare specifier resolves against the file the `import` is
	// written in, so a resolver importing from the kit's own directory would look for these packages beside
	// the kit. A flat node_modules hides that; a symlinked or nested install does not.
	load: (name) => import(name),
});

/** @param {{ shipsAs: string, title?: string }} agent */
export const resolveBinary = (agent) => resolver.resolveBinary(agent);

/**
 * Where the probe package put Datadog's precompiled eBPF objects, or null when it is not installed.
 *
 * The package states its own layout through its own accessor rather than this file computing it, because the
 * path is that package's business and a computed one goes stale the moment the layout changes. Null is an
 * ordinary answer: system-probe is opt-in, so most nodes have no probe package at all.
 *
 * The name is derived from the directory by one rule - `share/system-probe` gives `getShareSystemProbeDir` -
 * so a consumer can write the call without reading the staged package first.
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
//
// The key is `shipsAs`, and it is a file on disk rather than a label: the resolver above builds
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
//
// These two are the opt-in half of this package. Their binaries live in a separate platform package an
// operator installs by name, and system-probe wants privileges a Harper container does not have by default,
// so nothing here starts unless it was asked for. What this section refuses to do is fail quietly: a node
// that turned system-probe on and cannot run it says so at WARN with the reason, rather than restarting a
// process that exits every time.
//
// The config file matters even when neither agent runs. The core agent's workloadmeta process collector
// reads `discovery.enabled` out of the *system-probe* config, not its own
// (`comp/core/workloadmeta/collectors/internal/process/process_collector.go:191` at 7.82.1, via
// `serviceDiscoveryEnabled(systemProbeConfig)`), and that key defaults on. With no system-probe running,
// the collector polls a socket nothing serves and logs it about once a minute, which is the one steady-state
// ERROR this node reports. Writing a system-probe.yaml that says `discovery.enabled: false` stops it, and
// this component can write one because the core agent takes `--sysprobecfgpath` and reads it from wherever
// it is told rather than only from /etc/datadog-agent.

/** Whether a `DD_`-style flag reads as on. Absent is off here, unlike the process series: these cost privileges. */
const on = (value) =>
	["true", "1", "yes", "on"].includes(String(value ?? "").toLowerCase());

/**
 * What an operator asked for, in Datadog's own spelling.
 *
 * `DD_SYSTEM_PROBE_ENABLED` and `DD_RUNTIME_SECURITY_CONFIG_ENABLED` are the agent's own environment names
 * for these, so an operator's existing knowledge and any existing deployment config carry over unchanged.
 * Inventing `DD_HARPER_SYSTEM_PROBE_*` would have made this package the only place those names mean
 * anything.
 *
 * The modules are separate flags because they cost different things. NPM tracks every connection on the
 * host, USM parses protocol traffic; either can be wanted without the other, and both are off in Datadog's
 * own default too.
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
 * Whether this process could load an eBPF program on Linux, and if not, why.
 *
 * Root is the simple case. Otherwise the effective capability set says it, and `/proc/self/status`'s
 * `CapEff` is where the kernel publishes it as a hex mask. A kernel new enough to split CAP_BPF out of
 * CAP_SYS_ADMIN accepts either, so both bits are checked rather than the older one alone.
 *
 * One thing measured rather than assumed: `setcap` on the binary bridges the gap between a container's
 * bounding set and an unprivileged process's effective set, and it costs something. A binary that gained
 * privilege runs non-dumpable, `/proc/self/mem` becomes unreadable, and system-probe's kernel-version
 * detection then fails with `permission denied`. Running as root is the route that works, and it is what
 * Datadog's own agent container does.
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
 * The same question on macOS, where the answer has nothing to do with eBPF.
 *
 * The darwin tracer captures packets rather than loading programs, so what it needs is a BPF device:
 * `/dev/bpf0` and its siblings, which are root-owned and group `access_bpf`. Reported by trying to open
 * one, because the group membership, the device permissions and the sandbox all bear on whether it works
 * and only the open answers all three at once.
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
 * And on Windows, where it is neither capabilities nor a device but two signed kernel drivers.
 *
 * `\\.\ddnpm` and `\\.\ddprocmon` arrive in Datadog's MSI and install as kernel drivers, which needs
 * administrator rights and a signature chain an npm package cannot satisfy. So this reports the
 * requirement rather than testing it: opening a device to find out would be a side effect taken during a
 * status read, and the binary's own log says it plainly the moment it starts.
 */
const windowsPrivilege = () => ({
	able: null,
	why:
		"Windows system-probe reaches the kernel through the ddnpm and ddprocmon drivers, which this " +
		"package cannot install. Install them from Datadog's agent MSI; without them system-probe starts " +
		"and opens a device nothing created",
});

/**
 * Whether this host can run system-probe, and if not, what stands in the way.
 *
 * Three platforms, three different answers, and the mechanism differs on each: eBPF capabilities on Linux,
 * a BPF device on macOS, kernel drivers on Windows. `able: null` on Windows means unknown rather than
 * refused, because nothing here can tell whether the drivers are installed without opening one.
 *
 * Reported, never enforced. system-probe is the authority on what it can do, and a check here that refused
 * to start it would be this package overruling the binary on a heuristic. What this buys is a line naming
 * the missing thing instead of a restart loop whose logs say `operation not permitted`.
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
 * What this node resolved about system-probe and security-agent, and what stands between it and running
 * them.
 *
 * Reported rather than enforced. The binary is the authority on whether it can load an eBPF program, so a
 * refusal here would be this component overruling it on a heuristic. What this replaces is a restart loop
 * whose logs say `operation not permitted` and nothing about which capability is missing.
 *
 * @param {ProbeSettings} probes What probeSettings() resolved from the environment.
 * @param {string | null} ebpfDir Where the precompiled objects are, or null if none were found.
 * @param {{ log: import('@deliciousmonster/harper-process-guard').Log }} context
 */
export function probeStatus(probes, ebpfDir, { log }) {
	const reasons = [];
	if (probes.systemProbe) {
		const privilege = probePrivilege();
		// `able: null` is Windows: unknown rather than refused, because nothing here can tell whether the
		// drivers are installed without opening one. Reported as a blocker either way, since an operator
		// who has not installed them needs to read it.
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
//
// Where every file the agents read is written, and the one call that renders them. Under Harper's root,
// never the component directory.

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
		// Where runtime security looks for its rule policies. Under the runtime tree, not
		// /etc/datadog-agent/runtime-security.d, which is the stock install's path and which the
		// harperdb user cannot create.
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
	// Created whether or not runtime security runs: an enabled policy engine pointed at a directory that
	// does not exist logs `error while loading policies` every start, and an empty directory is a
	// correct answer meaning "no custom rules", where a missing one is a misconfiguration.
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
		// Harper's own log and the agents' as log sources, written whenever the root is known. The agent
		// tails them only when logs are on, which is DD_LOGS_ENABLED=true in the environment; off, this
		// file costs nothing.
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
//
// Stated once each, so the URL a verifier polls, the URL the probe blocklist names, and the `source` a status
// read reports can never be different ports or schemes. A mismatch in the blocklist is exactly the traffic it
// exists to keep out of the host application's APM.

/** The trace-agent's APM receiver. A receiver that does not advertise /v0.4/traces is not one dd-trace can use. */
export const receiverInfoUrl = (port) => `http://127.0.0.1:${port}/info`;

/** The core agent's expvar, and process-agent's, which is the same shape on its own port. */
export const expvarUrl = (port) => `http://127.0.0.1:${port}/debug/vars`;

/** The trace-agent's own expvar. https, because it serves it under the self-signed IPC certificate. */
export const debugVarsUrl = (port) => `https://127.0.0.1:${port}/debug/vars`;
