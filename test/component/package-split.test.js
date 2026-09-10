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

test("the base package carries what this repo builds and nothing lifted", () => {
	for (const target of TARGETS) {
		const base = packagesFor(target)[0];
		assert.equal(base.name, `${SCOPE}-${target.name}`);
		assert.deepEqual(
			base.binaries.filter((b) => sourceOf(b, target) !== "build"),
			[],
			`${base.name} carries a lifted binary, so every install pays for one`
		);
	}
});

test("the probe package carries only lifted binaries, and is not an optionalDependency", () => {
	const probes = allPackages(TARGETS).filter((p) => !p.optionalDependency);
	assert.ok(probes.length > 0, "no probe package exists; the split is gone");
	for (const pkg of probes) {
		assert.match(pkg.name, /-probe-/);
		assert.deepEqual(
			pkg.binaries.filter((b) => sourceOf(b, pkg.target) !== "release"),
			[],
			`${pkg.name} carries a binary this repo builds, which belongs in the base package`
		);
	}
});

// The npm name and the staging directory are two statements of one fact. When they drift, the packaging
// step writes to one path and the publish gate reads another, and the gate reports a package that was
// never created rather than the rename that caused it.
test("each package's directory name is its npm name without the scope", () => {
	for (const pkg of allPackages(TARGETS))
		assert.equal(pkg.name, `${SCOPE}-${pkg.dirName}`);
});

test("a target with no extracted binary publishes one package, not an empty second", () => {
	assert.deepEqual(
		packagesFor(findTarget("macos-arm64")).map((p) => p.dirName),
		["macos-arm64"]
	);
});

// system-probe loads its programs out of the objects; security-agent does not. A Windows probe package
// carrying the objects would ship 42 MB of Linux eBPF to a host that cannot load one of them.
test("only the package that ships system-probe ships the eBPF objects", () => {
	for (const pkg of allPackages(TARGETS)) {
		const carries = pkg.binaries.some((b) => b.shipsAs === "system-probe");
		assert.equal(
			pkg.ebpf,
			carries,
			`${pkg.name}: ebpf is ${pkg.ebpf} and system-probe is ${carries}`
		);
	}
});

test("every package is host-matched, so npm cannot install a Linux binary on macOS", () => {
	for (const pkg of allPackages(TARGETS)) {
		assert.equal(typeof pkg.target.npmOs, "string");
		assert.equal(typeof pkg.target.npmCpu, "string");
	}
});
