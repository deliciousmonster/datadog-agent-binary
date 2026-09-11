// What Datadog is on this node: the binaries, the processes that run them, the ports they agree on, and every
// file they read. One file, because there is one answer to "what did this node tell the agents" and splitting
// it put the port a probe reads three modules away from the config line that pinned it.
//
// Nothing here reads anything back. That is runtime/component.js, which imports what it needs from this file
// and nothing the other way: a renderer that polled would be a config file that depends on a running agent.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
	createBinaryResolver,
	hostRoot,
	resolvePort,
	writeFiles,
} from "@deliciousmonster/harper-process-guard";

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
	// Written here rather than inside the guard: a bare specifier resolves against the file the `import` is
	// written in, so a resolver importing from the guard's own directory would look for these packages beside
	// the guard. A flat node_modules hides that; a symlinked or nested install does not.
	load: (name) => import(name),
});

/** @param {{ shipsAs: string, title?: string }} agent */
export const resolveBinary = (agent) => resolver.resolveBinary(agent);

/**
 * Where the probe package put Datadog's precompiled eBPF objects, or null when it is not installed.
 *
 * The package states its own layout through `getEbpfDir()` rather than this file computing it, because the
 * path is that package's business and a computed one goes stale the moment the layout changes. Null is an
 * ordinary answer: system-probe is opt-in, so most nodes have no probe package at all.
 */
export const resolveEbpfDir = () => resolver.resolveDir(PROBE, "getEbpfDir");

// -- The ports ---------------------------------------------------------------------------------------------

/**
 * Read once per component instance, because every worker thread renders the config and probes the endpoints
 * from these numbers and a second reading could disagree with the first.
 *
 * @param {import('@deliciousmonster/harper-process-guard').Log} log
 */
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
	const has = (bit) => (mask >> bit) & 1n;
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
				`this process is not root and cannot open /dev/bpf0 (${error.code ?? error.message}), so the ` +
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
 * @param {object} probes What probeSettings() resolved from the environment.
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

// -- The files the agents read -----------------------------------------------------------------------------
//
// The datadog.yaml both agents read, and the core-check configs without which the core agent runs, reports
// healthy and collects nothing. Everything here is written under Harper's root, never the component directory.

/**
 * Where the objects actually sit under the directory the probe package reports.
 *
 * The package ships `share/system-probe/`, and upstream's own default is
 * `${install_path}/embedded/share/system-probe/ebpf` (`pkg/config/setup/system_probe.go:128` at 7.82.1), so
 * `bpf_dir` names the `ebpf` child rather than its parent. Measured on a live container 2026-09-10: pointed
 * at the parent, system-probe finds no CO-RE object, falls through to runtime compilation, and fails with
 * `unable to find kernel headers`. It is a one-segment error that reads as a missing toolchain.
 */
const objectDir = (ebpfDir) => `${ebpfDir}/ebpf`;

/** The minimised BTF bundle shipped beside the objects, for kernels that publish none of their own. */
const btfBundle = (ebpfDir) => `${objectDir(ebpfDir)}/co-re/btf`;

/**
 * The system-probe.yaml every agent on this node reads.
 *
 * Written whether or not system-probe runs. Off, it is the file that stops the core agent asking a socket
 * nothing serves; on, it is where the socket, the log and the precompiled eBPF objects are named. One file
 * either way, because two would let the running config and the silencing config disagree.
 *
 * `bpf_dir` is the part that cannot be defaulted. The objects ship in the probe platform package rather than
 * at /opt/datadog-agent, so system-probe has to be told where they landed or it starts, answers `version`,
 * and loads not one program.
 *
 * `allow_prebuilt_fallback` has to be set for the same reason, and its default is the trap. Upstream
 * defaults it to false (`system_probe.go:138`), so a kernel that cannot do CO-RE loads nothing and the
 * prebuilt objects this package went to the trouble of extracting, verifying and shipping are dead weight
 * on disk. Shipping 42 MB that can never be read is worse than not shipping it, because the size says the
 * capability is there.
 */
export function renderSystemProbeYaml(paths, resolved, ebpfDir) {
	const yes = (value) => (value ? "true" : "false");
	const quote = (value) => JSON.stringify(String(value));
	return [
		"# GENERATED by resources.js on every Harper worker start. Edits are overwritten.",
		"# Read by system-probe (-c), by security-agent (--sysprobe-config) and by the core agent",
		"# (--sysprobecfgpath), so all three agree on the socket and on which modules exist.",
		"system_probe_config:",
		`  enabled: ${yes(resolved.systemProbe)}`,
		`  sysprobe_socket: ${quote(paths.sysprobeSocket)}`,
		...(ebpfDir
			? [
					"  # Where the probe platform package put Datadog's precompiled objects. Without this",
					"  # system-probe looks under /opt/datadog-agent, finds nothing, and loads no program.",
					`  bpf_dir: ${quote(objectDir(ebpfDir))}`,
					"  # The minimised BTF bundle shipped beside them. The kernel's own /sys/kernel/btf/vmlinux",
					"  # is used where it exists; this is what carries a kernel that publishes none.",
					`  btf_path: ${quote(btfBundle(ebpfDir))}`,
					"  # Without this the prebuilt objects are never loaded, whatever bpf_dir says: upstream",
					"  # defaults it off, and CO-RE or runtime compilation are then the only paths. Runtime",
					"  # compilation needs kernel headers a container does not have, so on a kernel where CO-RE",
					"  # does not apply the shipped objects are the only thing that works.",
					"  allow_prebuilt_fallback: true",
				]
			: []),
		"log_to_console: false",
		`log_file: ${quote(paths.sysprobeLog)}`,
		'log_file_max_size: "5Mb"',
		"log_file_max_rolls: 2",
		"# The core agent's workloadmeta collector reads this key from THIS file, not from datadog.yaml.",
		"# Off, it stops polling a socket nothing serves, which is the once-a-minute ERROR a node with no",
		"# system-probe reports. On, it is what service discovery runs through.",
		"discovery:",
		`  enabled: ${yes(resolved.modules.discovery)}`,
		"# Network Performance Monitoring: every connection on the host. Off by default here and in Datadog's",
		"# own config; DD_NETWORK_CONFIG_ENABLED=true turns it on.",
		"network_config:",
		`  enabled: ${yes(resolved.modules.networkMonitoring)}`,
		"# Universal Service Monitoring: protocol parsing on those connections.",
		"service_monitoring_config:",
		`  enabled: ${yes(resolved.modules.serviceMonitoring)}`,
		"runtime_security_config:",
		`  enabled: ${yes(resolved.security)}`,
		`  socket: ${quote(paths.securitySocket)}`,
		"  # The stock path is /etc/datadog-agent/runtime-security.d, which the harperdb user cannot",
		"  # create, so an enabled engine logs `error while loading policies` on every start.",
		"  policies:",
		`    dir: ${quote(paths.securityPolicies)}`,
		"",
	].join("\n");
}

/**
 * The security-agent's own config file.
 *
 * Separate from datadog.yaml because security-agent's `-c` takes its own list and a node that runs it wants
 * its log somewhere other than the core agent's. Everything else it needs it reads from the system-probe
 * config it is pointed at.
 */
export function renderSecurityAgentYaml(paths, resolved) {
	const quote = (value) => JSON.stringify(String(value));
	return [
		"# GENERATED by resources.js on every Harper worker start. Edits are overwritten.",
		"log_to_console: false",
		`log_file: ${quote(paths.securityLog)}`,
		'log_file_max_size: "5Mb"',
		"log_file_max_rolls: 2",
		"runtime_security_config:",
		`  enabled: ${resolved.security ? "true" : "false"}`,
		`  socket: ${quote(paths.securitySocket)}`,
		"  policies:",
		`    dir: ${quote(paths.securityPolicies)}`,
		"# Off unless asked for: CSPM scans the host's configuration and is a separate product from runtime",
		"# security. DD_COMPLIANCE_CONFIG_ENABLED=true turns it on, and the environment outranks this file.",
		"compliance_config:",
		"  enabled: false",
		"",
	].join("\n");
}

/** YAML-safe scalar; double quotes also survive Windows drive letters. */
const yamlString = (value) => JSON.stringify(String(value));

/** The datadog.yaml both agents read: every path off the unwritable Datadog defaults, and the three ports this component probes written as the values it resolved, so a change to an agent default cannot move a port out from under a probe. */
function renderDatadogYaml(paths, ports) {
	return [
		"# GENERATED by resources.js on every Harper worker start. Edits are overwritten.",
		"# api_key and site are absent by design: they ride in DD_API_KEY / DD_SITE, never on disk.",
		"# The component's own settings are not here either, because the agent does not read them. They are",
		"# DD_HARPER_PROCESS_METRICS_ENABLED / _INTERVAL / _INCLUDE / _EXCLUDE, and the resolved values are",
		"# reported by the DatadogStatus endpoint under `processMetrics`.",
		`confd_path: ${yamlString(paths.confd)}`,
		`run_path: ${yamlString(paths.run)}`,
		`auth_token_file_path: ${yamlString(paths.authToken)}`,
		`ipc_cert_file_path: ${yamlString(paths.ipcCert)}`,
		"# The agents log under the runtime tree; a stdio pipe would tie them to one worker thread.",
		"log_to_console: false",
		`log_file: ${yamlString(paths.coreLog)}`,
		// Both agents read these same top-level keys; apm_config has no rotation settings of its own.
		// 5 MiB by 2 rolls bounds each log file at 15 MiB, against a default that bounds nothing here.
		'log_file_max_size: "5Mb"',
		"log_file_max_rolls: 2",
		"# Loopback only. Nothing here should be reachable from outside the container.",
		'bind_host: "127.0.0.1"',
		"# Empty, so the agent does not try to bind a Unix socket at /var/run/datadog/, which is the stock",
		"# install's path and does not exist beside a component. Measured on 7.82.1: unset, every start logs",
		"# `Can't init UDS listener` at ERROR, which now reaches whoever reads this node's logs. DogStatsD",
		"# still listens on UDP, which is the port a tracer's runtime metrics use.",
		'dogstatsd_socket: ""',
		"# Pinned because this component sends its own per-process series here. Unpinned, the sender",
		"# reads the port from DD_DOGSTATSD_PORT or 8125 and the agent reads it from its own default, and a",
		"# change to that default would drop the series on the floor with nothing logged on either side.",
		`dogstatsd_port: ${ports.dogstatsd}`,
		"# The logs agent keeps its tail-offset registry, and the integrations launcher its spool, under this",
		"# path rather than the top-level run_path. Measured on 7.82.1: unset, every start logs `Unable to",
		"# create integrations logs directory: mkdir /opt/datadog-agent: permission denied` at ERROR, 57 of them",
		"# over a day's restarts, and the registry has nowhere to live, so a restarted node re-tails every log",
		"# from the beginning instead of resuming.",
		"logs_config:",
		`  run_path: ${yamlString(paths.run)}`,
		"# Pinned because the core-agent verify reads expvar off this port. Measured on 7.82.1: the environment",
		"# outranks this file, so a set DD_EXPVAR_PORT wins and this only pins the port against a default that moves.",
		`expvar_port: ${ports.expvar}`,
		"# Live Processes: every process on the node with its CPU, memory and command line, Harper and the agents",
		"# included. Go, so it runs in this Python-free build; DD_PROCESS_CONFIG_PROCESS_COLLECTION_ENABLED=false",
		"# turns it off, since the environment outranks this file.",
		"process_config:",
		"  process_collection:",
		"    enabled: true",
		"  # process-agent's own expvar and log, which the core agent ignores and process-agent reads from",
		"  # this same file. Pinned for the same reason as the others: a probe reads the port this resolved.",
		`  expvar_port: ${ports.processExpvar}`,
		`  log_file: ${yamlString(paths.processLog)}`,
		"apm_config:",
		"  enabled: true",
		`  receiver_port: ${ports.receiver}`,
		"  # On, this binds 0.0.0.0 and accepts spans from anything that reaches the container.",
		"  apm_non_local_traffic: false",
		"  # Empty for the same reason as dogstatsd_socket: /var/run/datadog/ is the stock install's path and",
		"  # does not exist beside a component. Measured on 7.82.1: unset, every start logs `Could not start UDS",
		"  # listener: socket directory does not exist` at ERROR and the socket never binds. The receiver a",
		"  # tracer dials is the TCP port above.",
		'  receiver_socket: ""',
		`  log_file: ${yamlString(paths.traceLog)}`,
		"  # The sampler keeps this many traces a second per service and drops the rest. The default of 10",
		"  # was discarding 58% of a 24-trace-per-second demo whose whole purpose is showing traces, so a",
		"  # node that wants every span sets it above its own rate rather than discovering the loss in a",
		"  # sample-rate column. The key is target_traces_per_second: `target_tps` is the agent's internal",
		"  # field name and is silently ignored, and max_traces_per_second is deprecated in its favour.",
		"  # DD_APM_TARGET_TRACES_PER_SECOND overrides it; the environment outranks this file.",
		`  target_traces_per_second: ${TARGET_TPS}`,
		"  # The trace-agent's own expvar, separate from the core agent's. Without it nothing on this node",
		"  # can say whether a span that reached the receiver ever left for Datadog.",
		"  debug:",
		`    port: ${ports.debug}`,
		"",
	].join("\n");
}

/** Traces a second the sampler keeps per service. 10 is the agent's default and is below a busy demo. */
const TARGET_TPS = 200;

const HARPER_LOG_CHECK = "harper.d";

/**
 * Log sources for what runs on this node: every log Harper writes under its log directory (`logging.root`
 * is `log` under the root path unless a node moved it; the HTTP request log `http.logging` enables lands
 * there too, under its own name), and the two agents' and the reaper's, which are the first thing an
 * operator wants when the node stops reporting. Tailed only while logs are enabled (DD_LOGS_ENABLED=true).
 */
function renderLogSources(harperLog, paths) {
	const source = (path, service, source) => [
		"  - type: file",
		`    path: ${yamlString(path)}`,
		`    service: ${service}`,
		`    source: ${source}`,
	];
	return [
		"# GENERATED by resources.js on every Harper worker start. Edits are overwritten.",
		"# Tailed only while logs are enabled (DD_LOGS_ENABLED=true).",
		"logs:",
		...source(join(dirname(harperLog), "*.log"), "harper", "harper"),
		...source(paths.coreLog, "datadog-agent", "datadog-agent"),
		...source(paths.traceLog, "datadog-trace-agent", "datadog-agent"),
		// Tailed by path, whether or not the file exists yet: the logs agent picks one up when it appears,
		// so a node that turns system-probe on later needs no config change to see its log.
		...source(paths.sysprobeLog, "datadog-system-probe", "datadog-agent"),
		...source(paths.processLog, "datadog-process-agent", "datadog-agent"),
		...source(paths.securityLog, "datadog-security-agent", "datadog-agent"),
		...source(paths.reaperLog, REAPER_NAME, "harper-process-guard"),
		"",
	].join("\n");
}

/** The shipped core checks that apply here; an optional `platforms` file beside a check gates it, absent means everywhere. */
function collectCoreChecks(packageConfd) {
	const checks = [];
	const entries = readdirSync(packageConfd, { withFileTypes: true }).sort(
		(a, b) => (a.name < b.name ? -1 : 1)
	);
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.endsWith(".d")) continue;
		const source = join(packageConfd, entry.name, "conf.yaml.default");
		if (!existsSync(source)) continue;
		const gate = join(packageConfd, entry.name, "platforms");
		if (existsSync(gate)) {
			const platforms = readFileSync(gate, "utf-8")
				.replace(/#.*$/gm, "")
				.split(/\s+/)
				.filter(Boolean);
			if (!platforms.includes(process.platform)) continue;
		}
		checks.push({
			dir: entry.name,
			name: entry.name.slice(0, -".d".length),
			body: readFileSync(source, "utf-8"),
		});
	}
	return checks;
}

/** This start owns exactly the conf.yaml.default files. One nobody claims was left by an older version on a persistent volume; an operator's own conf.yaml is never touched. */
function removeStaleDefaults(confd, owned) {
	for (const entry of readdirSync(confd, { withFileTypes: true })) {
		if (entry.isDirectory() && !owned.has(entry.name)) {
			rmSync(join(confd, entry.name, "conf.yaml.default"), { force: true });
		}
	}
}

// The runtime tree lives under Harper's root, never the component directory, which `harper deploy` replaces
// under a live agent. Named by the component's own directory, not just "datadog": sharing one pidDir means sharing one lock.
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
				renderLogSources(join(root, "log", "hdb.log"), paths);
			owned.add(HARPER_LOG_CHECK);
		}
		removeStaleDefaults(paths.confd, owned);
	} catch (error) {
		log.warn(
			`${LABEL}: no core check configuration was collected (${error.message}), so the agent ` +
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
