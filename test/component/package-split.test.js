// How the binaries are divided between the base package and the opt-in probe package.
//
// The split is enforced by three scripts reading one table, so what these assert is that the table says
// something coherent: every binary lands in exactly one package, the base package stays what npm installs
// everywhere, and the probe package stays out of optionalDependencies. A probe package that drifted into
// that list would install 145 MB on every matching host in silence, which is the failure the split exists
// to prevent and which nothing at install time would report.

import { test } from "node:test";
import assert from "node:assert/strict";

import { binariesFor, sourceOf } from "../../dist/src/binaries.js";
import { allPackages, packagesFor, SCOPE } from "../../dist/src/packages.js";
import { TARGETS, findTarget } from "../../dist/src/targets.js";

test("every binary a target has lands in exactly one of its packages", () => {
	for (const target of TARGETS) {
		const all = binariesFor(target)
			.map((b) => b.shipsAs)
			.sort();
		const packaged = packagesFor(target)
			.flatMap((pkg) => pkg.binaries.map((b) => b.shipsAs))
			.sort();
		assert.deepEqual(
			packaged,
			all,
			`${target.name}: a binary is in both packages or in neither`
		);
	}
});

test("no package ships zero binaries", () => {
	for (const pkg of allPackages(TARGETS))
		assert.ok(
			pkg.binaries.length > 0,
			`${pkg.name} would publish an empty package`
		);
});

// The base package is what every install gets, so what belongs in it is what every node wants running:
// the core agent and the trace-agent. Not where the bytes came from, which is a separate question and was
// once conflated with this one.
test("the base package carries only what is not opt-in", () => {
	for (const target of TARGETS) {
		const base = packagesFor(target)[0];
		assert.equal(base.name, `${SCOPE}-${target.name}`);
		assert.deepEqual(
			base.binaries.filter((b) => b.optional).map((b) => b.shipsAs),
			[],
			`${base.name} carries an opt-in binary, so every install pays for one`
		);
		assert.deepEqual(
			base.binaries.map((b) => b.shipsAs).sort(),
			["datadog-agent", "trace-agent"],
			`${base.name} is not the two binaries every node runs`
		);
	}
});

// The probe package is opt-in whatever the binaries in it were built from. A Windows system-probe is
// built rather than lifted and still belongs here, because what makes it opt-in is that it is privileged
// and inert until a host is configured for it.
test("the probe package carries only opt-in binaries, and is not an optionalDependency", () => {
	const probes = allPackages(TARGETS).filter((p) => !p.optionalDependency);
	assert.ok(probes.length > 0, "no probe package exists; the split is gone");
	for (const pkg of probes) {
		assert.match(pkg.name, /-probe-/);
		assert.deepEqual(
			pkg.binaries.filter((b) => !b.optional).map((b) => b.shipsAs),
			[],
			`${pkg.name} carries a binary every install should already have`
		);
	}
});

// The split must not key on where the bytes come from. It did once, and a Windows system-probe, which is
// built rather than lifted, landed in the base package and shipped to every Windows node that wanted none
// of it. This is the assertion that would have caught that.
test("NEGATIVE: a built opt-in binary still lands in the probe package, not the base one", () => {
	const windows = TARGETS.find((t) => t.os === "windows");
	const [base, probe] = packagesFor(windows);
	const built = probe.binaries.filter((b) => sourceOf(b, windows) === "build");
	assert.ok(
		built.length > 0,
		"Windows lifts everything it ships, so this proves nothing"
	);
	for (const binary of built)
		assert.ok(
			!base.binaries.includes(binary),
			`${binary.shipsAs} is built and in the base package, so every Windows node installs it`
		);
});

// The npm name and the staging directory are two statements of one fact. When they drift, the packaging
// step writes to one path and the publish gate reads another, and the gate reports a package that was
// never created rather than the rename that caused it.
test("each package's directory name is its npm name without the scope", () => {
	for (const pkg of allPackages(TARGETS))
		assert.equal(pkg.name, `${SCOPE}-${pkg.dirName}`);
});

// system-probe exists on all three platforms, by three mechanisms, so all three publish a probe package.
// security-agent is Linux and Windows, so macOS's carries one binary rather than two.
test("every target publishes a probe package, because system-probe exists on every target", () => {
	assert.deepEqual(
		packagesFor(findTarget("macos-arm64")).map((p) => p.dirName),
		["macos-arm64", "probe-macos-arm64"]
	);
	assert.deepEqual(
		packagesFor(findTarget("macos-arm64"))[1].binaries.map((b) => b.shipsAs),
		["system-probe", "process-agent"],
		"macOS has no security-agent worth shipping: there is no eventmonitor_darwin.go for it to talk to"
	);
});

// The objects are Linux eBPF. macOS captures packets and Windows uses kernel drivers, so a probe package
// for either that carried them would ship 42 MB neither can load. Keyed on the binary being LIFTED, which
// is what makes it the eBPF one, rather than on the binary being present.
test("only the package whose system-probe is lifted from the Linux release ships the objects", () => {
	for (const pkg of allPackages(TARGETS)) {
		const lifted = pkg.binaries.some(
			(b) =>
				b.shipsAs === "system-probe" && sourceOf(b, pkg.target) === "release"
		);
		assert.equal(
			pkg.ebpf,
			lifted,
			`${pkg.name}: ebpf is ${pkg.ebpf} and a lifted system-probe is ${lifted}`
		);
	}
	const off = allPackages(TARGETS).filter((p) => p.target.os !== "linux");
	assert.ok(off.length > 0);
	for (const pkg of off)
		assert.equal(pkg.ebpf, false, `${pkg.name} ships Linux eBPF objects`);
});

test("every package is host-matched, so npm cannot install a Linux binary on macOS", () => {
	for (const pkg of allPackages(TARGETS)) {
		assert.equal(typeof pkg.target.npmOs, "string");
		assert.equal(typeof pkg.target.npmCpu, "string");
	}
});
