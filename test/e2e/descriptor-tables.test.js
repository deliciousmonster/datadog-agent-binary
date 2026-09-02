"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	REPO_ROOT,
	generatePackages,
	TARGETS,
	BINARIES,
	currentTarget,
} = require("./support/generator.js");
const { findTarget } = require(path.join(REPO_ROOT, "dist", "targets.js"));

let workDir;
let packageDir;

// Runs the real generator in an isolated copy. Every assertion below iterates BINARIES, so a
// code path that assumes one binary fails here rather than at publish.
before(() => {
	({ workDir } = generatePackages({ prefix: "ddab-descriptors-" }));
	packageDir = path.join(workDir, "npm", currentTarget().name);
});

after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test("every binary in the table is packaged, not just the first", () => {
	assert.ok(
		BINARIES.length > 1,
		"the table has collapsed to one entry; this check is now vacuous"
	);
	for (const binary of BINARIES) {
		const shipped = path.join(
			packageDir,
			"bin",
			`${binary.shipsAs}${currentTarget().exe}`
		);
		assert.ok(
			fs.existsSync(shipped),
			`${binary.shipsAs} was not copied into the platform package`
		);
	}
});

test("the platform package resolves each binary by name", () => {
	const pkg = require(path.join(packageDir, "index.js"));
	for (const binary of BINARIES) {
		const expected = `${binary.shipsAs}${currentTarget().exe}`;
		assert.equal(path.basename(pkg.getBinaryPath(binary.shipsAs)), expected);
	}
});

test("an unnamed request resolves the first binary, so published packages keep working", () => {
	const pkg = require(path.join(packageDir, "index.js"));
	assert.equal(
		path.basename(pkg.getBinaryPath()),
		`${BINARIES[0].shipsAs}${currentTarget().exe}`
	);
});

test("an unknown binary name throws rather than returning a path that does not exist", () => {
	const pkg = require(path.join(packageDir, "index.js"));
	assert.throws(() => pkg.getBinaryPath("datadog-nonesuch"), /Unknown binary/);
});

// A relocatable npm artifact and Python integrations are mutually exclusive: the python tag links
// an embedded CPython and rpaths librtloader into the build tree. The flag is policy, not tuning.
test("the override adds flags and cannot drop the python exclusion", () => {
	const { buildArgs } = require(path.join(REPO_ROOT, "dist", "build.js"));
	const core = BINARIES.find((b) => b.shipsAs === "datadog-agent");
	assert.ok(core.mandatoryArgs.includes("--build-exclude=systemd,python"));

	process.env[core.argsOverride] = "--some-experiment";
	try {
		const args = buildArgs(core);
		assert.ok(
			args.includes("--build-exclude=systemd,python"),
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

// The trace-agent's build() has no rtloader parameter, so the core agent's excludes are rejected
// rather than ignored. Sharing one arg list would break the build this package exists for.
test("each binary carries its own mandatory args and its own override variable", () => {
	const overrides = BINARIES.map((b) => b.argsOverride);
	assert.equal(
		new Set(overrides).size,
		overrides.length,
		"two binaries share an override variable"
	);
	assert.deepEqual(
		BINARIES.find((b) => b.shipsAs === "trace-agent").mandatoryArgs,
		[]
	);
	assert.ok(
		BINARIES.find((b) => b.shipsAs === "datadog-agent").mandatoryArgs.includes(
			"--exclude-rtloader"
		)
	);
});

test("findTarget names the supported set when asked for one that is not", () => {
	assert.throws(() => findTarget("plan9-vax"), /Supported: .*linux-x86_64/);
	assert.equal(findTarget("linux-arm64").goarch, "arm64");
});

test("every target derives goos and goarch rather than restating them", () => {
	assert.equal(
		TARGETS.filter((t) => t.os === "macos").every((t) => t.goos === "darwin"),
		true
	);
	assert.deepEqual([...new Set(TARGETS.map((t) => t.goarch))].sort(), [
		"amd64",
		"arm64",
	]);
	assert.equal(TARGETS.find((t) => t.os === "windows").exe, ".exe");
});

test("currentTarget is a member of the supported table", () => {
	assert.ok(TARGETS.includes(findTarget(currentTarget().name)));
});

// The pin is what makes a build reproducible, and it is also what keeps CI off an unauthenticated
// GitHub API that rate-limits at 60 an hour per IP across every runner.
test("the agent version is pinned in the repo, not resolved from the network", async () => {
	const { pinnedVersion } = require(
		path.join(REPO_ROOT, "dist", "downloader.js")
	);
	const pin = await pinnedVersion();
	assert.match(
		pin ?? "",
		/^\d+\.\d+\.\d+$/,
		".datadog-agent-version must hold a release"
	);
	assert.equal(
		fs
			.readFileSync(path.join(REPO_ROOT, ".datadog-agent-version"), "utf8")
			.trim(),
		pin
	);
});
