"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..", "..");
const { currentTarget, findTarget, TARGETS } = require(
	path.join(REPO_ROOT, "dist", "targets.js")
);
const { BINARIES } = require(path.join(REPO_ROOT, "dist", "binaries.js"));

let workDir;
let packageDir;

// Runs the real generator in an isolated copy. Every assertion below iterates BINARIES, so a
// code path that assumes one binary fails here rather than at publish.
before(() => {
	const target = currentTarget();
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddab-descriptors-"));
	fs.mkdirSync(path.join(workDir, "scripts"));
	fs.mkdirSync(path.join(workDir, "dist"));
	fs.mkdirSync(path.join(workDir, "build", target.name, "bin"), {
		recursive: true,
	});

	fs.copyFileSync(
		path.join(REPO_ROOT, "scripts", "create-platform-packages.js"),
		path.join(workDir, "scripts", "create-platform-packages.js")
	);
	for (const table of ["targets.js", "binaries.js"]) {
		fs.copyFileSync(
			path.join(REPO_ROOT, "dist", table),
			path.join(workDir, "dist", table)
		);
	}
	fs.copyFileSync(
		path.join(REPO_ROOT, "package.json"),
		path.join(workDir, "package.json")
	);

	for (const binary of BINARIES) {
		fs.writeFileSync(
			path.join(
				workDir,
				"build",
				target.name,
				"bin",
				`${binary.shipsAs}${target.exe}`
			),
			`#!/bin/sh\necho ${binary.shipsAs}\n`
		);
	}

	execFileSync(
		process.execPath,
		[path.join(workDir, "scripts", "create-platform-packages.js")],
		{
			stdio: "ignore",
		}
	);
	packageDir = path.join(workDir, "npm", target.name);
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

// The trace-agent's build() has no rtloader parameter, so the core agent's excludes are rejected
// rather than ignored. Sharing one arg list would break the build that this whole package exists for.
test("each binary carries its own build args and its own override variable", () => {
	const overrides = BINARIES.map((b) => b.argsOverride);
	assert.equal(
		new Set(overrides).size,
		overrides.length,
		"two binaries share an override variable"
	);
	assert.deepEqual(BINARIES.find((b) => b.shipsAs === "trace-agent").args, []);
	assert.ok(
		BINARIES.find((b) => b.shipsAs === "datadog-agent").args.includes(
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
