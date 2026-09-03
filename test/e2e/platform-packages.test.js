import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { test, before, after } = require("node:test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT, generatePackages } = require("../support/generator.js");

const mainPkg = require(path.join(REPO_ROOT, "package.json"));

// What each generated platform package's os/cpu MUST be (Node's values).
const EXPECTED = {
	"linux-x86_64": { os: "linux", cpu: "x64" },
	"linux-arm64": { os: "linux", cpu: "arm64" },
	"macos-arm64": { os: "darwin", cpu: "arm64" },
	"windows-x86_64": { os: "win32", cpu: "x64" },
};

let workDir;
let npmDir;

before(() => {
	({ workDir, npmDir } = generatePackages({
		prefix: "ddab-platform-pkgs-",
		args: ["--all"],
	}));
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
		.map((n) => `@harperfast/datadog-agent-binary-${n}`)
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

// The list of targets and the CI matrix are two statements of the same fact. When they drift, the
// package publishes an optionalDependency nothing ever built and npm skips it without a word.
test("every supported target has a matrix leg that builds it, and vice versa", () => {
	const workflow = fs.readFileSync(
		path.join(REPO_ROOT, ".github", "workflows", "build-release.yml"),
		"utf8"
	);
	// Scoped to jobs.build.strategy.matrix.include, not the whole file: `include:` opens the block and
	// the job's `runs-on:` closes it, which is enough to avoid a full YAML parse.
	const includeAt = workflow.search(/^\s*include:\s*$/m);
	assert.notEqual(
		includeAt,
		-1,
		"found no matrix include: block; the workflow shape changed and this check is now blind"
	);
	const afterInclude = workflow.slice(includeAt);
	const endAt = afterInclude.search(/^\s*runs-on:/m);
	assert.notEqual(
		endAt,
		-1,
		"found no runs-on: after the matrix include block; the workflow shape changed"
	);
	const matrixBlock = afterInclude.slice(0, endAt);

	const legs = [...matrixBlock.matchAll(/^\s*platform:\s*(\S+)\s*$/gm)].map(
		(m) => m[1]
	);
	assert.ok(
		legs.length > 0,
		"extracted no matrix legs; the workflow shape changed and this check is now blind"
	);

	const { targetNames } = require(
		path.join(REPO_ROOT, "dist", "src", "targets.js")
	);
	assert.deepEqual(legs.slice().sort(), targetNames().slice().sort());
});

// npm force-ships LICENSE whatever `files` says, so the declared licence and the shipped text are
// two statements of one fact and a reader who checks either has to get the same answer.
test("the declared licence matches the licence file that ships", () => {
	const licence = fs.readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf8");
	assert.match(licence, /Apache License/);
	assert.equal(mainPkg.license, "Apache-2.0");
});

// The runtime half only ever runs inside Harper, so Harper's floor is this package's floor. Declaring
// lower invites an install npm permits and Harper then refuses.
test("the declared node floor is not looser than Harper's", () => {
	assert.equal(mainPkg.engines.node, "^22.18.0 || >=24.0.0");
});
