import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
	REPO_ROOT,
	BINARIES,
	currentTarget,
	scaffoldWorkDir,
} = require("../support/generator.js");

const TARGET = currentTarget();
const workDirs = [];
after(() => {
	for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// One tree shaped like the repo root: verify-package.js resolves dist/src/* and npm/ relative to its
// own location, the same trick create-platform-packages.js's own tests use to run in isolation.
function buildFixture({ guard = "populated", binOverrides = {} } = {}) {
	const workDir = scaffoldWorkDir("ddab-publish-gate-");
	workDirs.push(workDir);

	fs.copyFileSync(
		path.join(REPO_ROOT, "scripts", "verify-package.js"),
		path.join(workDir, "scripts", "verify-package.js")
	);
	fs.writeFileSync(
		path.join(workDir, "package.json"),
		JSON.stringify({
			name: "publish-gate-fixture",
			version: "0.0.0",
			files: ["guard/src/", "guard/package.json"],
		})
	);

	if (guard === "populated") {
		fs.mkdirSync(path.join(workDir, "guard", "src"), { recursive: true });
		fs.writeFileSync(path.join(workDir, "guard", "package.json"), "{}");
		fs.writeFileSync(
			path.join(workDir, "guard", "src", "index.js"),
			"module.exports = {};"
		);
	} else if (guard === "empty") {
		fs.mkdirSync(path.join(workDir, "guard"));
	}

	const binDir = path.join(workDir, "npm", TARGET.name, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(workDir, "npm", TARGET.name, "package.json"),
		JSON.stringify({
			name: `platform-fixture-${TARGET.name}`,
			version: "0.0.0",
			files: ["bin/"],
		})
	);
	for (const binary of BINARIES) {
		const override = binOverrides[binary.shipsAs];
		if (override === "missing") continue;
		fs.writeFileSync(
			path.join(binDir, `${binary.shipsAs}${TARGET.exe}`),
			override ?? `${binary.requiredSymbol}\n`
		);
	}

	return workDir;
}

// missing => the file is not written at all, standing in for a build that silently dropped an agent.
const missingAll = () =>
	Object.fromEntries(BINARIES.map((b) => [b.shipsAs, "missing"]));

function runGate(workDir) {
	try {
		const stdout = execFileSync(
			process.execPath,
			[path.join(workDir, "scripts", "verify-package.js")],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
		);
		return { status: 0, stdout };
	} catch (error) {
		return { status: error.status, stdout: error.stdout, stderr: error.stderr };
	}
}

test("a well-formed package, guard/ populated and every binary carrying its symbol, passes", () => {
	const result = runGate(buildFixture());
	assert.equal(result.status, 0, result.stderr);
});

test("NEGATIVE: guard/ absent from the tarball refuses the release", () => {
	const result = runGate(buildFixture({ guard: "absent" }));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /guard\/ is absent or empty/);
});

test("NEGATIVE: guard/ present but empty refuses the release", () => {
	const result = runGate(buildFixture({ guard: "empty" }));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /guard\/ is absent or empty/);
});

test("NEGATIVE: a platform package with zero binaries refuses the release", () => {
	const result = runGate(buildFixture({ binOverrides: missingAll() }));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /ships zero binaries/);
});

// The regression this whole project chases: one agent shipped, the other silently absent, and the
// package still looked correct from inside the working tree.
test("NEGATIVE: one agent missing while the other ships refuses the release", () => {
	const result = runGate(
		buildFixture({ binOverrides: { "trace-agent": "missing" } })
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /trace-agent is missing/);
});

test("NEGATIVE: a shipped binary missing its required symbol refuses the release", () => {
	const result = runGate(
		buildFixture({ binOverrides: { "trace-agent": "nothing relevant here\n" } })
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /required symbol .* appears 0 times/);
});

test("NEGATIVE: a shipped binary carrying the forbidden symbol refuses the release", () => {
	const result = runGate(
		buildFixture({
			binOverrides: {
				"datadog-agent":
					"datadog-agent/pkg/aggregator and datadog-agent/pkg/collector/python\n",
			},
		})
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /forbidden symbol .* is present/);
});

test("every binary in the table declares a required symbol, so this gate has something to check", () => {
	for (const binary of BINARIES) {
		assert.ok(binary.requiredSymbol, `${binary.shipsAs} has no requiredSymbol`);
	}
});
