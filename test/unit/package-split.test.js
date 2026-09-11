// How the binaries divide between the base package and the opt-in probe package, declared once in
// binary-kit.config.js and read by the staging, the publish gate and the optionalDependencies writer.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	allPackages,
	optionalDependencies,
	packagesFor,
} from "@deliciousmonster/harper-binary-kit/packages";
import { target, targets } from "@deliciousmonster/harper-binary-kit/targets";

import config, { SCOPE } from "../../binary-kit.config.js";
import { binariesFor, sourceOf } from "../../agent-build/binaries.js";
import { findTarget, TARGETS } from "../../agent-build/toolchain.js";

const KIT_TARGETS = targets(config.targets);
const carried = (pkg) => pkg.binaries.map((binary) => binary.shipsAs).sort();

test("every binary a target has lands in exactly one of its packages", () => {
	for (const declared of TARGETS) {
		const all = binariesFor(declared)
			.map((binary) => binary.shipsAs)
			.sort();
		const packaged = packagesFor(config, target(declared.name))
			.flatMap(carried)
			.sort();
		assert.deepEqual(
			packaged,
			all,
			`${declared.name}: a binary is in both packages or in neither`
		);
	}
});

test("no package ships zero binaries", () => {
	for (const pkg of allPackages(config, KIT_TARGETS))
		assert.ok(
			pkg.binaries.length > 0,
			`${pkg.name} would publish an empty package`
		);
});

// What belongs in the base package is what every node wants running: the core agent and the trace-agent.
// Not where the bytes came from, which is a separate question and was once conflated with this one.
test("the base package carries only what is not opt-in", () => {
	for (const on of KIT_TARGETS) {
		const [base] = packagesFor(config, on);
		assert.equal(base.name, `${SCOPE}-${on.name}`);
		assert.deepEqual(
			carried(base),
			["datadog-agent", "trace-agent"],
			`${base.name} is not the two binaries every node runs`
		);
	}
});

// The probe package is opt-in whatever the binaries in it were built from.
test("the probe package carries only opt-in binaries, and is not an optionalDependency", () => {
	const pinned = optionalDependencies(config, KIT_TARGETS, "0.0.0");
	const probes = allPackages(config, KIT_TARGETS).filter(
		(pkg) => !pkg.optionalDependency
	);
	assert.ok(probes.length > 0, "no probe package exists; the split is gone");
	for (const pkg of probes) {
		assert.match(pkg.name, /-probe-/);
		assert.ok(
			!(pkg.name in pinned),
			`${pkg.name} is an optionalDependency, so npm installs it on every matching host`
		);
		for (const shipped of carried(pkg))
			assert.ok(
				["system-probe", "process-agent", "security-agent"].includes(shipped),
				`${pkg.name} carries ${shipped}, which every install should already have`
			);
	}
});

// The npm name and the staging directory are two statements of one fact.
test("each package's directory name is its npm name without the scope", () => {
	for (const pkg of allPackages(config, KIT_TARGETS))
		assert.equal(pkg.name, `${SCOPE}-${pkg.dirName}`);
});

// system-probe exists on all three platforms, by three mechanisms, so all three publish a probe package.
// security-agent is Linux and Windows, so macOS's carries two binaries rather than three.
test("every target publishes a probe package, because system-probe exists on every target", () => {
	assert.deepEqual(
		packagesFor(config, target("macos-arm64")).map((pkg) => pkg.dirName),
		["macos-arm64", "probe-macos-arm64"]
	);
	assert.deepEqual(carried(packagesFor(config, target("macos-arm64"))[1]), [
		"process-agent",
		"system-probe",
	]);
});

// The objects are Linux eBPF.
test("only the Linux probe packages carry the eBPF objects", () => {
	for (const pkg of allPackages(config, KIT_TARGETS)) {
		const lifted = binariesFor(findTarget(pkg.target.name)).some(
			(binary) =>
				binary.shipsAs === "system-probe" &&
				carried(pkg).includes("system-probe") &&
				sourceOf(binary, findTarget(pkg.target.name)) === "release"
		);
		assert.equal(
			pkg.extraDirs.length > 0,
			lifted,
			`${pkg.name}: extraDirs is ${JSON.stringify(pkg.extraDirs)} and a lifted system-probe is ${lifted}`
		);
	}
});

test("every package is host-matched, so npm cannot install a Linux binary on macOS", () => {
	for (const pkg of allPackages(config, KIT_TARGETS)) {
		assert.equal(typeof pkg.target.npmOs, "string");
		assert.equal(typeof pkg.target.npmCpu, "string");
	}
});

// The list of targets and the CI matrix are two statements of the same fact. When they drift, the package
// publishes an optionalDependency nothing ever built and npm skips it without a word.
test("the declared targets are the targets CI builds", async () => {
	const { readFile } = await import("node:fs/promises");
	const workflow = await readFile(
		new URL("../../.github/workflows/build-release.yml", import.meta.url),
		"utf8"
	);
	const legs = [...workflow.matchAll(/^\s*platform:\s*(\S+)\s*$/gm)].map(
		(match) => match[1]
	);
	assert.ok(legs.length > 0, "extracted no matrix legs; this check is blind");
	assert.deepEqual(legs.slice().sort(), [...config.targets].sort());
});
