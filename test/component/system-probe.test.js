// system-probe and security-agent: what turns them on, what stands in the way, and the config that is
// written whether or not either runs.
//
// The assertion that carries the most weight here is the one about the file written when both are off. The
// core agent reads `discovery.enabled` out of the system-probe config rather than its own, and that key
// defaults on, so a node with no system-probe polls a socket nothing serves and logs it about once a
// minute. A test that only checked the enabled path would pass on a build that had stopped writing the file
// at all, and the log noise would come back with nothing failing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	probePrivilege,
	probeSettings,
	renderSecurityAgentYaml,
	renderSystemProbeYaml,
} from "../../runtime/datadog.js";

const PATHS = {
	sysprobeSocket: "/run/sysprobe.sock",
	securitySocket: "/run/runtime-security.sock",
	sysprobeLog: "/logs/system-probe.log",
	securityLog: "/logs/security-agent.log",
};

/** The key's value in a rendered YAML block, so a test names the key rather than a line number. */
const valueOf = (yaml, key) =>
	new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(yaml)?.[1];

test("both agents are off unless something turned them on", () => {
	const resolved = probeSettings({});
	assert.equal(resolved.systemProbe, false);
	assert.equal(resolved.security, false);
	for (const [name, on] of Object.entries(resolved.modules))
		assert.equal(on, false, `${name} is on with nothing asking for it`);
});

// Off is the default because these cost privileges, which is the opposite of the process series, where
// anything but an explicit falsehood is on so a typo cannot silently stop the data.
test("NEGATIVE: a value that is not an explicit truth leaves system-probe off", () => {
	for (const value of ["", "maybe", "TRUE ", "0", "no", undefined])
		assert.equal(
			probeSettings({ DD_SYSTEM_PROBE_ENABLED: value }).systemProbe,
			false,
			`DD_SYSTEM_PROBE_ENABLED=${JSON.stringify(value)} turned it on`
		);
	assert.equal(
		probeSettings({ DD_SYSTEM_PROBE_ENABLED: "true" }).systemProbe,
		true
	);
	assert.equal(
		probeSettings({ DD_SYSTEM_PROBE_ENABLED: "TRUE" }).systemProbe,
		true
	);
});

// NPM watches every connection on the host and USM parses their traffic. Either is a decision on its own,
// and Datadog's own default leaves both off, so turning system-probe on must not turn them on with it.
test("NEGATIVE: system-probe alone turns on neither network nor service monitoring", () => {
	const resolved = probeSettings({ DD_SYSTEM_PROBE_ENABLED: "true" });
	assert.equal(resolved.modules.networkMonitoring, false);
	assert.equal(resolved.modules.serviceMonitoring, false);
	// Discovery follows system-probe, because it is the module the core agent asks for unprompted.
	assert.equal(resolved.modules.discovery, true);
});

test("a module cannot be on while system-probe is off, whatever its own flag says", () => {
	const resolved = probeSettings({
		DD_NETWORK_CONFIG_ENABLED: "true",
		DD_SERVICE_MONITORING_CONFIG_ENABLED: "true",
		DD_DISCOVERY_ENABLED: "true",
	});
	assert.equal(resolved.systemProbe, false);
	for (const [name, on] of Object.entries(resolved.modules))
		assert.equal(on, false, `${name} is on with no system-probe to run it`);
});

test("discovery can be turned off on a node that runs system-probe for something else", () => {
	const resolved = probeSettings({
		DD_SYSTEM_PROBE_ENABLED: "true",
		DD_DISCOVERY_ENABLED: "false",
		DD_NETWORK_CONFIG_ENABLED: "true",
	});
	assert.equal(resolved.modules.discovery, false);
	assert.equal(resolved.modules.networkMonitoring, true);
});

// The whole point of writing the file on a node that runs neither agent.
test("with everything off, the config still turns discovery off", () => {
	const yaml = renderSystemProbeYaml(PATHS, probeSettings({}), null);
	assert.match(yaml, /^discovery:$/m);
	assert.equal(valueOf(yaml.split("discovery:")[1], "enabled"), "false");
	assert.equal(valueOf(yaml, "sysprobe_socket"), '"/run/sysprobe.sock"');
});

test("NEGATIVE: with everything off, nothing in the config claims to be enabled", () => {
	const yaml = renderSystemProbeYaml(PATHS, probeSettings({}), null);
	const enabled = [...yaml.matchAll(/^\s*enabled:\s*(\S+)\s*$/gm)].map(
		(m) => m[1]
	);
	assert.ok(enabled.length >= 4, "the config declares almost nothing");
	assert.deepEqual(
		enabled.filter((v) => v !== "false"),
		[],
		"a module reads as enabled on a node that asked for none"
	);
});

// Without bpf_dir system-probe looks under /opt/datadog-agent, which is not where an npm package puts
// anything, so it starts, answers `version`, and loads not one program. Present and inert is the worst
// outcome available here, because everything downstream reports healthy.
// Measured on a live container 2026-09-10, and it cost a deploy to find. The probe package reports
// `share/system-probe`, and upstream's own default is `.../share/system-probe/ebpf`
// (pkg/config/setup/system_probe.go:128 at 7.82.1), so bpf_dir names the child. One segment out,
// system-probe finds no CO-RE object, falls through to runtime compilation, and fails with `unable to find
// kernel headers`, which reads as a missing toolchain rather than as a wrong path.
test("bpf_dir names the ebpf directory, not the directory holding it", () => {
	const yaml = renderSystemProbeYaml(
		PATHS,
		probeSettings({ DD_SYSTEM_PROBE_ENABLED: "true" }),
		"/n/m/pkg/share/system-probe"
	);
	assert.equal(valueOf(yaml, "bpf_dir"), '"/n/m/pkg/share/system-probe/ebpf"');
	assert.equal(
		valueOf(yaml, "btf_path"),
		'"/n/m/pkg/share/system-probe/ebpf/co-re/btf"'
	);
});

// The other half of the same deploy. `allow_prebuilt_fallback` defaults to false upstream
// (system_probe.go:138), so without it the prebuilt objects are never read whatever bpf_dir says, and the
// 42 MB this package extracts, verifies and ships is dead weight that makes the capability look present.
test("the prebuilt objects are allowed to load, or shipping them buys nothing", () => {
	const yaml = renderSystemProbeYaml(
		PATHS,
		probeSettings({ DD_SYSTEM_PROBE_ENABLED: "true" }),
		"/n/m/pkg/share/system-probe"
	);
	assert.equal(valueOf(yaml, "allow_prebuilt_fallback"), "true");
});

test("NEGATIVE: no bpf_dir key is written when no probe package supplied one", () => {
	const yaml = renderSystemProbeYaml(
		PATHS,
		probeSettings({ DD_SYSTEM_PROBE_ENABLED: "true" }),
		null
	);
	for (const key of ["bpf_dir", "btf_path", "allow_prebuilt_fallback"])
		assert.doesNotMatch(
			yaml,
			new RegExp(`${key}:`),
			`wrote ${key} with no objects to point at, which names a path that does not exist`
		);
});

test("the security-agent config names its own log and socket, not the core agent's", () => {
	const yaml = renderSecurityAgentYaml(
		PATHS,
		probeSettings({ DD_RUNTIME_SECURITY_CONFIG_ENABLED: "true" })
	);
	assert.equal(valueOf(yaml, "log_file"), '"/logs/security-agent.log"');
	assert.equal(valueOf(yaml, "socket"), '"/run/runtime-security.sock"');
	assert.match(yaml, /runtime_security_config:/);
});

// CSPM scans the host's configuration and is a separate product from runtime security. Turning one on must
// not turn the other on, or a node buys a product it did not ask for.
test("NEGATIVE: runtime security does not turn compliance scanning on with it", () => {
	const yaml = renderSecurityAgentYaml(
		PATHS,
		probeSettings({ DD_RUNTIME_SECURITY_CONFIG_ENABLED: "true" })
	);
	const compliance = yaml.split("compliance_config:")[1];
	assert.ok(
		compliance,
		"the compliance block is gone, so its default is unstated"
	);
	assert.equal(valueOf(compliance, "enabled"), "false");
});

test("root can load an eBPF program", () => {
	const verdict = probePrivilege({
		read: () => "CapEff:\t0000000000000000\n",
		uid: () => 0,
		platform: "linux",
	});
	assert.equal(verdict.able, true);
	assert.match(verdict.why, /root/);
});

// The kernel publishes the effective set as a hex mask, and CAP_SYS_ADMIN is bit 21. A node run with
// --cap-add SYS_ADMIN and no root is the ordinary container case.
test("CAP_SYS_ADMIN without root is enough, and so is CAP_BPF alone", () => {
	const mask = (bit) => (1n << BigInt(bit)).toString(16).padStart(16, "0");
	for (const bit of [21, 39]) {
		const verdict = probePrivilege({
			read: () => `CapEff:\t${mask(bit)}\n`,
			uid: () => 1000,
			platform: "linux",
		});
		assert.equal(verdict.able, true, `bit ${bit} was not accepted`);
	}
});

// The failure this exists to replace: a restart loop whose logs say `operation not permitted` and nothing
// about which capability is missing.
test("NEGATIVE: an unprivileged process is refused and told what to add", () => {
	const verdict = probePrivilege({
		read: () => "CapEff:\t0000000000000400\n",
		uid: () => 1000,
		platform: "linux",
	});
	assert.equal(verdict.able, false);
	assert.match(verdict.why, /CAP_SYS_ADMIN/);
	assert.match(verdict.why, /cap-add/);
	assert.match(verdict.why, /0x400/);
});

// Unknown is not permission. A container that publishes no CapEff line must not read as capable, because
// the reply an operator gets would then be "nothing is wrong" from a node that cannot start the process.
// Three platforms, three mechanisms, and reporting the wrong one sends an operator to fix something that
// was never the problem. macOS uses no eBPF at all, so a capability message there is nonsense.
test("macOS is judged on a BPF device, not on capabilities it does not use", () => {
	const able = probePrivilege({
		platform: "darwin",
		uid: () => 1000,
		openBpf: () => undefined,
	});
	assert.equal(able.able, true);
	assert.match(able.why, /bpf/i);

	const denied = probePrivilege({
		platform: "darwin",
		uid: () => 1000,
		openBpf: () => {
			const e = new Error("permission denied");
			e.code = "EACCES";
			throw e;
		},
	});
	assert.equal(denied.able, false);
	assert.match(denied.why, /access_bpf/);
	assert.doesNotMatch(
		denied.why,
		/CAP_|eBPF program/,
		"told a macOS operator to add a Linux capability"
	);
});

// Windows is unknown rather than refused: nothing here can tell whether the drivers are installed without
// opening one, and opening a device during a status read is a side effect a read should not take.
test("Windows reports the drivers as unknown, not as a capability that is missing", () => {
	const verdict = probePrivilege({ platform: "win32" });
	assert.equal(verdict.able, null);
	assert.match(verdict.why, /ddnpm/);
	assert.match(verdict.why, /ddprocmon/);
	assert.doesNotMatch(verdict.why, /CAP_|access_bpf/);
});

test("NEGATIVE: a platform with no system-probe at all says so", () => {
	const verdict = probePrivilege({ platform: "aix" });
	assert.equal(verdict.able, false);
	assert.match(verdict.why, /no system-probe for aix/);
});

test("NEGATIVE: capabilities that cannot be read are not treated as capabilities that are held", () => {
	const verdict = probePrivilege({
		read: () => {
			throw new Error("no /proc here");
		},
		uid: () => 1000,
		platform: "linux",
	});
	assert.equal(verdict.able, false);
	assert.match(verdict.why, /could not be read/);
});
