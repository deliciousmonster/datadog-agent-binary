// system-probe and security-agent: whether to run them, and the config they and the core agent share.
//
// These two are the opt-in half of this package. Their binaries live in a separate platform package an
// operator installs by name, and system-probe wants privileges a Harper container does not have by default,
// so nothing here starts unless it was asked for. What this module refuses to do is fail quietly: a node
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

import { closeSync, openSync, readFileSync } from "node:fs";

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
export function settings(env = process.env) {
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

/**
 * What this node resolved about system-probe and security-agent, and what stands between it and running
 * them.
 *
 * Reported rather than enforced. The binary is the authority on whether it can load an eBPF program, so a
 * refusal here would be this component overruling it on a heuristic. What this replaces is a restart loop
 * whose logs say `operation not permitted` and nothing about which capability is missing.
 *
 * @param {object} probes What settings() resolved from the environment.
 * @param {string | null} ebpfDir Where the precompiled objects are, or null if none were found.
 * @param {{ log: import('@deliciousmonster/harper-process-guard').Log, packageName: string }} context
 */
export function probeStatus(probes, ebpfDir, { log, packageName }) {
	const reasons = [];
	if (probes.systemProbe) {
		const privilege = probePrivilege();
		// `able: null` is Windows: unknown rather than refused, because nothing here can tell whether the
		// drivers are installed without opening one. Reported as a blocker either way, since an operator
		// who has not installed them needs to read it.
		if (privilege.able !== true) reasons.push(privilege.why);
		if (!ebpfDir)
			reasons.push(
				`no precompiled eBPF objects were found: ${packageName}-probe-<platform> is what ships them, ` +
					"and without it system-probe starts, answers `version`, and loads not one program"
			);
		for (const reason of reasons)
			log.warn(
				`Datadog supervisor: DD_SYSTEM_PROBE_ENABLED is set and ${reason}`
			);
	}
	return {
		...probes,
		ebpfDir,
		// Empty means nothing known stands in the way, which is not the same as a running probe. The
		// process's own verified verdict is what says that, and it is reported beside this.
		blockers: reasons,
	};
}
