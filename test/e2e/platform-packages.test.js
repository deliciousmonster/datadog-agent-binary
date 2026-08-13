"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function findRepoRoot(start) {
	let dir = start;
	while (!fs.existsSync(path.join(dir, "package.json"))) {
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error("Could not locate package root");
		dir = parent;
	}
	return dir;
}

const REPO_ROOT = findRepoRoot(__dirname);
const mainPkg = require(path.join(REPO_ROOT, "package.json"));
// Derived, never hardcoded: package.json's `name` is the single source of truth for the
// scope, so a re-scope cannot leave this test asserting the old one.
const PACKAGE_NAME = mainPkg.name;

// Every published binary, per platform: the accessor the platform package must
// export and the filename that accessor has to resolve inside bin/. Written out
// literally rather than read back from Platform.getBinaries(), so a descriptor
// change has to be restated here; the generator reading its own input proves
// nothing about what actually ships.
const CORE = { kind: "core", accessor: "getBinaryPath" };
const TRACE = { kind: "trace", accessor: "getTraceAgentBinaryPath" };

function unixBinaries() {
	return [
		{ ...CORE, file: "datadog-agent" },
		{ ...TRACE, file: "trace-agent" },
	];
}

function windowsBinaries() {
	return [
		{ ...CORE, file: "datadog-agent.exe" },
		{ ...TRACE, file: "trace-agent.exe" },
	];
}

// What each generated platform package's os/cpu MUST be (Node's values), and
// what its index.js must resolve.
const EXPECTED = {
	"linux-x86_64": { os: "linux", cpu: "x64", binaries: unixBinaries() },
	"linux-arm64": { os: "linux", cpu: "arm64", binaries: unixBinaries() },
	"macos-x86_64": { os: "darwin", cpu: "x64", binaries: unixBinaries() },
	"macos-arm64": { os: "darwin", cpu: "arm64", binaries: unixBinaries() },
	"windows-x86_64": { os: "win32", cpu: "x64", binaries: windowsBinaries() },
};

let workDir;
let npmDir;

before(() => {
	// Run the generator in an isolated copy so we don't write into the repo.
	// realpath: on macOS os.tmpdir() is /var/... which is a symlink to /private/var,
	// and the generated index.js reports __dirname (already resolved). Without this
	// the path assertions compare two spellings of the same directory.
	workDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ddab-platform-pkgs-"))
	);
	fs.mkdirSync(path.join(workDir, "scripts"));
	fs.mkdirSync(path.join(workDir, "dist"));
	fs.copyFileSync(
		path.join(REPO_ROOT, "scripts", "create-platform-packages.js"),
		path.join(workDir, "scripts", "create-platform-packages.js")
	);
	// The generator only requires dist/platform.js (type imports are erased).
	fs.copyFileSync(
		path.join(REPO_ROOT, "dist", "platform.js"),
		path.join(workDir, "dist", "platform.js")
	);
	fs.copyFileSync(
		path.join(REPO_ROOT, "package.json"),
		path.join(workDir, "package.json")
	);

	execFileSync(
		process.execPath,
		[path.join(workDir, "scripts", "create-platform-packages.js"), "--dummy"],
		{ stdio: "ignore" }
	);
	npmDir = path.join(workDir, "npm");
});

after(() => {
	if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

function readGenerated() {
	const out = {};
	for (const name of fs.readdirSync(npmDir)) {
		const pj = path.join(npmDir, name, "package.json");
		if (fs.existsSync(pj)) {
			out[name] = JSON.parse(fs.readFileSync(pj, "utf8"));
		}
	}
	return out;
}

test("generates exactly the expected set of platform packages", () => {
	const generated = Object.keys(readGenerated()).sort();
	assert.deepEqual(generated, Object.keys(EXPECTED).sort());
});

test("each platform package has npm-valid os/cpu (Node values, not human-readable)", () => {
	const generated = readGenerated();
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const pkg = generated[name];
		assert.ok(pkg, `missing generated package: ${name}`);
		assert.deepEqual(
			pkg.os,
			[expected.os],
			`${name}: os must be ${expected.os} (npm matches process.platform)`
		);
		assert.deepEqual(
			pkg.cpu,
			[expected.cpu],
			`${name}: cpu must be ${expected.cpu} (npm matches process.arch)`
		);
	}
});

test("generated package names exactly match the main package optionalDependencies", () => {
	const generatedNames = Object.keys(readGenerated())
		.map((n) => `${PACKAGE_NAME}-${n}`)
		.sort();
	const declared = Object.keys(mainPkg.optionalDependencies).sort();
	assert.deepEqual(generatedNames, declared);
});

test("all platform packages are pinned to the main package version", () => {
	const generated = readGenerated();
	for (const [name, pkg] of Object.entries(generated)) {
		assert.equal(
			pkg.version,
			mainPkg.version,
			`${name} version should equal main package version ${mainPkg.version}`
		);
	}
	// optionalDependencies must also all reference that same version.
	for (const [dep, range] of Object.entries(mainPkg.optionalDependencies)) {
		assert.equal(range, mainPkg.version, `${dep} should be ${mainPkg.version}`);
	}
});

test("os/cpu never leak this project's internal platform names", () => {
	// The macos-x86_64 platform package shipped with os "macos" and
	// cpu "x86_64", our own names. npm compares those fields against
	// process.platform/process.arch ("darwin"/"x64"), so that package could never
	// install anywhere and the optional dependency was skipped in silence, which
	// looks identical to "the platform isn't supported".
	const INTERNAL_NAMES = new Set(["macos", "windows", "x86_64"]);
	for (const [name, pkg] of Object.entries(readGenerated())) {
		for (const value of [...pkg.os, ...pkg.cpu]) {
			assert.ok(
				!INTERNAL_NAMES.has(value),
				`${name}: "${value}" is this project's internal name, not a Node ` +
					`process.platform/process.arch value; npm would never install this package`
			);
		}
	}
});

/** Load a generated platform package's index.js the way a consumer would. */
function loadIndex(platformName) {
	const indexPath = path.join(npmDir, platformName, "index.js");
	assert.ok(
		fs.existsSync(indexPath),
		`${platformName}: no index.js was generated`
	);
	return require(indexPath);
}

test("every platform package exports an accessor for every binary it ships", () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const index = loadIndex(name);
		for (const binary of expected.binaries) {
			assert.equal(
				typeof index[binary.accessor],
				"function",
				`${name}: index.js must export ${binary.accessor}(). BinaryManager resolves ` +
					`the ${binary.kind} binary by calling exactly that name, and a package ` +
					`missing it resolves nothing while still installing cleanly`
			);
		}
	}
});

test("each accessor resolves bin/<binary> inside its own package", () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const index = loadIndex(name);
		const packageDir = path.join(npmDir, name);
		for (const binary of expected.binaries) {
			const resolved = index[binary.accessor]();
			assert.equal(
				resolved,
				path.join(packageDir, "bin", binary.file),
				`${name}: ${binary.accessor}() must point at bin/${binary.file}`
			);
			assert.ok(
				path.isAbsolute(resolved),
				`${name}: ${binary.accessor}() must return an absolute path; Harper's ` +
					`allowlist is an exact string match against the absolute command`
			);
		}
	}
});

test("the binaries map enumerates both kinds with their published filenames", () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const index = loadIndex(name);
		assert.deepEqual(
			index.binaries,
			Object.fromEntries(expected.binaries.map((b) => [b.kind, b.file])),
			`${name}: the binaries map is how a consumer enumerates what actually shipped ` +
				`instead of guessing per-platform filenames`
		);
	}
});

test("index.js exports the accessors and the binaries map, and nothing else", () => {
	// A stray or duplicated accessor is the shape a copy-paste regression takes,
	// and it is invisible: the extra export resolves a path that was never copied
	// into bin/.
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const exported = Object.keys(loadIndex(name)).sort();
		const wanted = [
			...expected.binaries.map((b) => b.accessor),
			"binaries",
		].sort();
		assert.deepEqual(exported, wanted, `${name}: unexpected index.js exports`);
	}
});

test("--dummy mode still generates both accessors", () => {
	// The whole suite runs the generator with --dummy (no built binaries needed),
	// so every assertion above already exercises that mode. Stated explicitly
	// because --dummy is the only path CI can run without a Go toolchain: if it
	// ever regressed to emitting a single accessor, this suite would be testing
	// something that never ships.
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const index = loadIndex(name);
		assert.equal(expected.binaries.length, 2);
		for (const binary of expected.binaries) {
			assert.equal(
				typeof index[binary.accessor],
				"function",
				`${name}/${binary.kind}`
			);
		}
		// --dummy never populates bin/; the accessors are still expected to exist.
		assert.ok(!fs.existsSync(path.join(npmDir, name, "bin")));
	}
});

test("every platform package publishes bin/ and index.js", () => {
	for (const [name, pkg] of Object.entries(readGenerated())) {
		for (const entry of ["bin/", "index.js"]) {
			assert.ok(
				pkg.files.includes(entry),
				`${name}: "files" must include ${entry}, or npm publishes a package whose ` +
					`accessors point at paths that are not in the tarball`
			);
		}
	}
});
