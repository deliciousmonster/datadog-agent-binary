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

const SECOND = {
	shipsAs: "datadog-trace-agent",
	task: "trace-agent.build",
	builtIn: "bin/trace-agent",
	builtAs: "trace-agent",
	args: [],
	argsOverride: "DD_TRACE_AGENT_BUILD_ARGS",
	requiredSymbol: "pkg/trace/api.",
};

let workDir;
let packageDir;

// Runs the real generator against a BINARIES table with a second entry appended, which is
// the only change MOD-2 should need. Anything assuming a single binary fails here.
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
	fs.copyFileSync(
		path.join(REPO_ROOT, "dist", "targets.js"),
		path.join(workDir, "dist", "targets.js")
	);
	fs.copyFileSync(
		path.join(REPO_ROOT, "package.json"),
		path.join(workDir, "package.json")
	);

	const { BINARIES } = require(path.join(REPO_ROOT, "dist", "binaries.js"));
	const table = [...BINARIES, SECOND];
	fs.writeFileSync(
		path.join(workDir, "dist", "binaries.js"),
		`exports.BINARIES = ${JSON.stringify(table)};`
	);
	for (const binary of table) {
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
		{ stdio: "ignore" }
	);
	packageDir = path.join(workDir, "npm", target.name);
});

after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test("a second BINARIES entry is packaged with no change to the generator", () => {
	const target = currentTarget();
	for (const binary of [
		...require(path.join(REPO_ROOT, "dist", "binaries.js")).BINARIES,
		SECOND,
	]) {
		const shipped = path.join(
			packageDir,
			"bin",
			`${binary.shipsAs}${target.exe}`
		);
		assert.ok(
			fs.existsSync(shipped),
			`${binary.shipsAs} was not copied into the platform package`
		);
	}
});

test("the platform package resolves each binary by name", () => {
	const pkg = require(path.join(packageDir, "index.js"));
	const target = currentTarget();
	assert.equal(
		path.basename(pkg.getBinaryPath("datadog-trace-agent")),
		`datadog-trace-agent${target.exe}`
	);
	assert.equal(
		path.basename(pkg.getBinaryPath("datadog-agent")),
		`datadog-agent${target.exe}`
	);
});

test("an unnamed request resolves the first binary, so published packages keep working", () => {
	const pkg = require(path.join(packageDir, "index.js"));
	assert.equal(
		path.basename(pkg.getBinaryPath()),
		`datadog-agent${currentTarget().exe}`
	);
});

test("an unknown binary name throws rather than returning a path that does not exist", () => {
	const pkg = require(path.join(packageDir, "index.js"));
	assert.throws(() => pkg.getBinaryPath("datadog-nonesuch"), /Unknown binary/);
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
