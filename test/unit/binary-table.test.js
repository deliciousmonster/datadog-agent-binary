// The binary table: what this package ships, where each one comes from, and how each is built.
//
// The packaging half of this file left when the kit took over staging. What stayed is the half only this
// repo can answer: a descriptor names a Datadog binary, an invoke task, the flags that task must always be
// given, and the platforms the binary exists on at all. Those four are what a build reads, and every one of
// them was got wrong at least once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, BINARIES, binariesFor } from "../support/generator.js";
import { buildArgs } from "../../agent-build/compile.js";
import { pinnedVersion } from "../../agent-build/download.js";
import { TARGETS, findTarget } from "../../agent-build/toolchain.js";

// Python is excluded and settled: not because it cannot be shipped, which was disproven, but because
// runtime/series.js produces the one metric family a Harper node wants and nothing else in
// integrations-core is worth 634 MB a platform. systemd left this flag, because it rode in on python's
// coat-tails with no measurement recorded for it.
test("the override adds flags and cannot drop the python exclusion", () => {
	const core = BINARIES.find((binary) => binary.shipsAs === "datadog-agent");
	assert.ok(core.mandatoryArgs.includes("--build-exclude=python"));

	process.env[core.argsOverride] = "--some-experiment";
	try {
		const args = buildArgs(core);
		assert.ok(
			args.includes("--build-exclude=python"),
			"an override dropped the python exclusion"
		);
		assert.ok(
			args.includes("--some-experiment"),
			"the override contributed nothing"
		);
	} finally {
		delete process.env[core.argsOverride];
	}
});

// The trace-agent's build() has no rtloader parameter, so the core agent's excludes are rejected rather
// than ignored. Sharing one arg list would break the build this package exists for.
test("each binary carries its own mandatory args and its own override variable", () => {
	const overrides = BINARIES.map((binary) => binary.argsOverride);
	assert.equal(
		new Set(overrides).size,
		overrides.length,
		"two binaries share an override variable"
	);
	assert.deepEqual(
		BINARIES.find((binary) => binary.shipsAs === "trace-agent").mandatoryArgs,
		[]
	);
	assert.ok(
		BINARIES.find(
			(binary) => binary.shipsAs === "datadog-agent"
		).mandatoryArgs.includes("--exclude-rtloader")
	);
});

test("systemd is no longer excluded, and python still is", () => {
	// systemd rode in on python's flag with no measurement or test recorded for it, and cost the journald
	// log source and the systemd integration. Python is settled on its own terms; systemd never had terms.
	const core = BINARIES.find((binary) => binary.shipsAs === "datadog-agent");
	const excludes = core.mandatoryArgs.filter((arg) =>
		arg.startsWith("--build-exclude=")
	);
	assert.deepEqual(excludes, ["--build-exclude=python"]);
});

test("findTarget names the supported set when asked for one that is not", () => {
	assert.throws(() => findTarget("plan9-vax"), /Supported: .*linux-x86_64/);
	assert.equal(findTarget("linux-arm64").goarch, "arm64");
});

test("the table spells goos, goarch and exe the way the Go toolchain names them, not the way this package does", () => {
	assert.equal(
		TARGETS.filter((target) => target.os === "macos").every(
			(target) => target.goos === "darwin"
		),
		true
	);
	assert.deepEqual(
		[...new Set(TARGETS.map((target) => target.goarch))].sort(),
		["amd64", "arm64"]
	);
	assert.equal(TARGETS.find((target) => target.os === "windows").exe, ".exe");
});

// The pin is what makes a build reproducible, and it is also what keeps CI off an unauthenticated GitHub
// API that rate-limits at 60 an hour per IP across every runner.
test("the agent version is pinned in the repo, not resolved from the network", async () => {
	const pin = await pinnedVersion();
	assert.match(
		pin ?? "",
		/^\d+\.\d+\.\d+$/,
		".datadog-agent-version must hold a release"
	);
	assert.equal(
		readFileSync(join(REPO_ROOT, ".datadog-agent-version"), "utf8").trim(),
		pin
	);
});

// system-probe and security-agent were absent for reasons that never survived contact. system-probe was
// deleted as collateral in `0c52271`, a commit replacing a hand-written build with upstream's; its cost is
// service discovery, NPM, USM and the ebpf checks, and the core agent logs a socket it cannot reach once a
// minute because of it. security-agent was never in the table at all, and its cost is CWS and CSPM.
test("the table ships the five binaries the agent is, not the two it was", () => {
	assert.deepEqual(
		BINARIES.map((binary) => binary.shipsAs).sort(),
		[
			"datadog-agent",
			"process-agent",
			"security-agent",
			"system-probe",
			"trace-agent",
		],
		"a binary left out of this table is a Datadog capability the package cannot deliver"
	);
});

test("a binary that is not cross-platform says so, and the filter honours it", () => {
	// system-probe exists on all three, by three mechanisms: eBPF on Linux, packet capture on macOS
	// (tracer_darwin.go), kernel drivers on Windows (ddnpm, ddprocmon). It carried onlyOn: ["linux"] once,
	// on an inference from a skipped build_object_files that is true only where the probes are eBPF.
	const probe = BINARIES.find((binary) => binary.shipsAs === "system-probe");
	assert.equal(probe.onlyOn, undefined, "system-probe exists on every target");

	// security-agent is Linux and Windows. It compiles on darwin (main_nix.go is !windows) and there is no
	// eventmonitor_darwin.go, so a macOS one would start with nothing to talk to.
	const security = BINARIES.find(
		(binary) => binary.shipsAs === "security-agent"
	);
	assert.deepEqual(security.onlyOn, ["linux", "windows"]);

	const shipsAs = (os) => binariesFor({ os }).map((binary) => binary.shipsAs);
	for (const os of ["linux", "macos", "windows"])
		assert.ok(
			shipsAs(os).includes("system-probe"),
			`${os} ships no system-probe`
		);
	assert.ok(!shipsAs("macos").includes("security-agent"));
	assert.ok(shipsAs("windows").includes("security-agent"));
});

test("NEGATIVE: the two that are cross-platform stay on every system", () => {
	// A filter that over-reaches would silently stop shipping the agents this package exists for.
	for (const os of ["linux", "macos", "windows"]) {
		const names = binariesFor({ os }).map((binary) => binary.shipsAs);
		assert.ok(names.includes("datadog-agent"), os);
		assert.ok(names.includes("trace-agent"), os);
	}
});

// Every descriptor has to declare a symbol, or binary-kit.config.js hands the publish gate a binary with
// nothing to check and the gate approves it for having no question to ask.
test("every binary declares the symbol the publish gate reads back", () => {
	for (const binary of BINARIES)
		assert.ok(binary.requiredSymbol, `${binary.shipsAs} has no requiredSymbol`);
});
