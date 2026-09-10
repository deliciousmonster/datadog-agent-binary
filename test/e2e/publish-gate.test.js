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
	TARGETS,
	packagesFor,
	currentTarget,
	scaffoldWorkDir,
} = require("../support/generator.js");
const { EBPF_SHIP_DIR } = require(
	path.join(REPO_ROOT, "dist", "src", "release.js")
);

const TARGET = currentTarget();
const workDirs = [];
after(() => {
	for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The build-info record Go writes into every binary it links, in the shape verify-package.js reads it
// back from. A tag set standing for a correct build: no `python`, and more than one entry, so a gate
// matching the line rather than the list would still have to pick the tag out of it.
const buildInfo = (tags = "zlib,zstd,orchestrator,kubelet") =>
	`build\t-buildmode=exe\nbuild\t-tags=${tags}\n`;

/** What a correctly-built binary looks like to a gate that only byte-searches: its symbol and its tag record. */
const shipped = (binary, tags) =>
	`${binary.requiredSymbol}\n${buildInfo(tags)}`;

// A well-formed platform package. Content is a text stand-in, never a real binary - verify-package.js only
// ever byte-searches it, same as create-platform-packages.js's own tests. What the declared symbol and tag
// are worth against a real build is test/binaries/publish-gate-values.test.js.
function writePlatformPackage(workDir, pkg, binOverrides = {}) {
	const { target } = pkg;
	const packageDir = path.join(workDir, "npm", pkg.dirName);
	const binDir = path.join(packageDir, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({
			name: `platform-fixture-${pkg.dirName}`,
			version: "0.0.0",
			files: pkg.ebpf ? ["bin/", `${EBPF_SHIP_DIR}/`] : ["bin/"],
			// What create-platform-packages.js writes off the descriptor. Omitted, npm skips the package on
			// every host and the gate has nothing to compare, so a fixture without these tests neither.
			os: [target.npmOs],
			cpu: [target.npmCpu],
		})
	);
	for (const binary of pkg.binaries) {
		const override = binOverrides[binary.shipsAs];
		if (override === "missing") continue;
		fs.writeFileSync(
			path.join(binDir, `${binary.shipsAs}${target.exe}`),
			override ?? shipped(binary)
		);
	}
	if (pkg.ebpf && binOverrides.ebpf !== "missing") {
		const objects = path.join(packageDir, EBPF_SHIP_DIR, "ebpf");
		fs.mkdirSync(objects, { recursive: true });
		fs.writeFileSync(path.join(objects, "tracer.o"), "\0not-an-elf");
	}
}

// One tree shaped like the repo root, every target holding a well-formed package by default.
// `binOverrides` only ever touches TARGET; `missingTargets` skips a directory entirely.
function buildFixture({ binOverrides = {}, missingTargets = [] } = {}) {
	const workDir = scaffoldWorkDir("ddab-publish-gate-");
	workDirs.push(workDir);

	// verify-package.js now imports REPO_ROOT/platformPackageDir from paths.js; the copied
	// script resolves that import relative to itself, so the fixture needs both files.
	for (const script of ["verify-package.js", "paths.js"]) {
		fs.copyFileSync(
			path.join(REPO_ROOT, "scripts", script),
			path.join(workDir, "scripts", script)
		);
	}
	fs.writeFileSync(
		path.join(workDir, "package.json"),
		JSON.stringify({
			name: "publish-gate-fixture",
			version: "0.0.0",
		})
	);

	for (const target of TARGETS) {
		if (missingTargets.includes(target.name)) continue;
		for (const pkg of packagesFor(target)) {
			writePlatformPackage(
				workDir,
				pkg,
				target.name === TARGET.name ? binOverrides : {}
			);
		}
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

test("a well-formed package, every binary carrying its symbol, passes", () => {
	const result = runGate(buildFixture());
	assert.equal(result.status, 0, result.stderr);
});

test("NEGATIVE: a platform package with zero binaries refuses the release", () => {
	const result = runGate(buildFixture({ binOverrides: missingAll() }));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /ships zero binaries/);
});

// The gap TARGETS-drives-the-loop exists for: a target whose package was never created leaves no
// npm/<name>/ directory at all, and a directory listing can only ever report what is there.
test("NEGATIVE: a target whose platform package was never created refuses the release", () => {
	const result = runGate(buildFixture({ missingTargets: [TARGET.name] }));
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		new RegExp(`${TARGET.name}: no platform package was ever created`)
	);
});

// The same gap, one layer deeper: create-platform-packages.js's copyPlatformBinary mkdirs bin/ before
// the loop that can throw, so the directory can exist - empty - with package.json still never written.
test("NEGATIVE: a platform directory with an empty bin/ and no package.json refuses the release", () => {
	const workDir = buildFixture({ missingTargets: [TARGET.name] });
	fs.mkdirSync(path.join(workDir, "npm", TARGET.name, "bin"), {
		recursive: true,
	});
	const result = runGate(workDir);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		new RegExp(`${TARGET.name}: no platform package was ever created`)
	);
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

const CORE = BINARIES.find((binary) => binary.forbiddenBuildTag);

test("NEGATIVE: a binary recording the forbidden build tag refuses the release", () => {
	const result = runGate(
		buildFixture({
			binOverrides: {
				[CORE.shipsAs]: shipped(CORE, `zlib,${CORE.forbiddenBuildTag},zstd`),
			},
		})
	);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		new RegExp(`was compiled with the "${CORE.forbiddenBuildTag}" build tag`)
	);
});

// The gate reads the exclusion off the artifact, so a binary it cannot read the record from is the one
// case where refusing and passing are both defensible. Passing makes every unreadable artifact publish.
test("NEGATIVE: a binary carrying no build-tag record refuses the release", () => {
	const result = runGate(
		buildFixture({
			binOverrides: { [CORE.shipsAs]: `${CORE.requiredSymbol}\n` },
		})
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /carries no Go build-tag record/);
});

// npm filters optionalDependencies on process.platform, so this never surfaces as an install error:
// the package is skipped, npm exits 0, and the host ends up with no agent and no warning.
test("NEGATIVE: a platform package whose os does not match its target refuses the release", () => {
	const workDir = buildFixture();
	const manifest = path.join(workDir, "npm", TARGET.name, "package.json");
	const written = JSON.parse(fs.readFileSync(manifest, "utf8"));
	fs.writeFileSync(
		manifest,
		JSON.stringify({ ...written, os: ["not-an-npm-platform"] })
	);
	const result = runGate(workDir);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		new RegExp(
			`${TARGET.name}: package.json os is \\["not-an-npm-platform"\\], must be \\["${TARGET.npmOs}"\\]`
		)
	);
});

// A dist/ compiled before npmOs/npmCpu moved onto Target leaves both sides of the comparison undefined,
// and a null agreeing with a null still ships. scaffoldWorkDir copies dist/src wholesale, so the stale
// table is reproducible by editing the copy.
test("NEGATIVE: a stale dist/ carrying no npm os refuses the release rather than agreeing with itself", () => {
	const workDir = buildFixture();
	const table = path.join(workDir, "dist", "src", "targets.js");
	fs.writeFileSync(
		table,
		fs
			.readFileSync(table, "utf8")
			.replace(/npmOs: "[^"]*",/g, "")
			.replace(/npmCpu: "[^"]*"/g, "npmCpu: undefined")
	);
	const result = runGate(workDir);
	assert.notEqual(result.status, 0);
	assert.match(
		result.stderr,
		new RegExp(
			`${TARGET.name}: src/targets.ts carries no npm os for this target`
		)
	);
});

test("every binary in the table declares a required symbol, so this gate has something to check", () => {
	for (const binary of BINARIES) {
		assert.ok(binary.requiredSymbol, `${binary.shipsAs} has no requiredSymbol`);
	}
});
