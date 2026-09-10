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
	eBPFPrivilege,
	renderSecurityAgentYaml,
	renderSystemProbeYaml,
	settings,
} from "../../runtime/system-probe.js";

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
	const resolved = settings({});
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
			settings({ DD_SYSTEM_PROBE_ENABLED: value }).systemProbe,
			false,
			`DD_SYSTEM_PROBE_ENABLED=${JSON.stringify(value)} turned it on`
		);
	assert.equal(settings({ DD_SYSTEM_PROBE_ENABLED: "true" }).systemProbe, true);
	assert.equal(settings({ DD_SYSTEM_PROBE_ENABLED: "TRUE" }).systemProbe, true);
});

// NPM watches every connection on the host and USM parses their traffic. Either is a decision on its own,
// and Datadog's own default leaves both off, so turning system-probe on must not turn them on with it.
test("NEGATIVE: system-probe alone turns on neither network nor service monitoring", () => {
	const resolved = settings({ DD_SYSTEM_PROBE_ENABLED: "true" });
	assert.equal(resolved.modules.networkMonitoring, false);
	assert.equal(resolved.modules.serviceMonitoring, false);
	// Discovery follows system-probe, because it is the module the core agent asks for unprompted.
	assert.equal(resolved.modules.discovery, true);
});

test("a module cannot be on while system-probe is off, whatever its own flag says", () => {
	const resolved = settings({
		DD_NETWORK_CONFIG_ENABLED: "true",
		DD_SERVICE_MONITORING_CONFIG_ENABLED: "true",
		DD_DISCOVERY_ENABLED: "true",
	});
	assert.equal(resolved.systemProbe, false);
	for (const [name, on] of Object.entries(resolved.modules))
		assert.equal(on, false, `${name} is on with no system-probe to run it`);
});

test("discovery can be turned off on a node that runs system-probe for something else", () => {
	const resolved = settings({
		DD_SYSTEM_PROBE_ENABLED: "true",
		DD_DISCOVERY_ENABLED: "false",
		DD_NETWORK_CONFIG_ENABLED: "true",
	});
	assert.equal(resolved.modules.discovery, false);
	assert.equal(resolved.modules.networkMonitoring, true);
});

// The whole point of writing the file on a node that runs neither agent.
test("with everything off, the config still turns discovery off", () => {
	const yaml = renderSystemProbeYaml(PATHS, settings({}), null);
	assert.match(yaml, /^discovery:$/m);
	assert.equal(valueOf(yaml.split("discovery:")[1], "enabled"), "false");
	assert.equal(valueOf(yaml, "sysprobe_socket"), '"/run/sysprobe.sock"');
});

test("NEGATIVE: with everything off, nothing in the config claims to be enabled", () => {
	const yaml = renderSystemProbeYaml(PATHS, settings({}), null);
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
test("the eBPF object directory is written into the config when the probe package supplies one", () => {
	const yaml = renderSystemProbeYaml(
		PATHS,
		settings({ DD_SYSTEM_PROBE_ENABLED: "true" }),
		"/n/m/pkg/share/system-probe"
	);
	assert.equal(valueOf(yaml, "bpf_dir"), '"/n/m/pkg/share/system-probe"');
});

test("NEGATIVE: no bpf_dir key is written when no probe package supplied one", () => {
	const yaml = renderSystemProbeYaml(
		PATHS,
		settings({ DD_SYSTEM_PROBE_ENABLED: "true" }),
		null
	);
	assert.doesNotMatch(
		yaml,
		/bpf_dir:/,
		"wrote a bpf_dir naming nothing, which points system-probe at a path that does not exist"
	);
});

test("the security-agent config names its own log and socket, not the core agent's", () => {
	const yaml = renderSecurityAgentYaml(
		PATHS,
		settings({ DD_RUNTIME_SECURITY_CONFIG_ENABLED: "true" })
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
		settings({ DD_RUNTIME_SECURITY_CONFIG_ENABLED: "true" })
	);
	const compliance = yaml.split("compliance_config:")[1];
	assert.ok(
		compliance,
		"the compliance block is gone, so its default is unstated"
	);
	assert.equal(valueOf(compliance, "enabled"), "false");
});

test("root can load an eBPF program", () => {
	const verdict = eBPFPrivilege({
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
		const verdict = eBPFPrivilege({
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
	const verdict = eBPFPrivilege({
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
// eBPF is Linux. A macOS or Windows node that set the flag has to hear that rather than a capability
// message about a facility its kernel does not have.
test("NEGATIVE: a system with no eBPF at all says so, rather than reporting a missing capability", () => {
	const verdict = eBPFPrivilege({ platform: "darwin" });
	assert.equal(verdict.able, false);
	assert.match(verdict.why, /Linux facility/);
	assert.doesNotMatch(verdict.why, /CAP_/);
});

test("NEGATIVE: capabilities that cannot be read are not treated as capabilities that are held", () => {
	const verdict = eBPFPrivilege({
		read: () => {
			throw new Error("no /proc here");
		},
		uid: () => 1000,
		platform: "linux",
	});
	assert.equal(verdict.able, false);
	assert.match(verdict.why, /could not be read/);
});
