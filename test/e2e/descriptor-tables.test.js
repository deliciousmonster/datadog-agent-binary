import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { test, before, after } = require("node:test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	REPO_ROOT,
	generatePackages,
	TARGETS,
	BINARIES,
	binariesFor,
	currentTarget,
} = require("../support/generator.js");
const { findTarget } = require(
	path.join(REPO_ROOT, "dist", "src", "targets.js")
);

let workDir;
let packageDir;

// Runs the real generator in an isolated copy. Every assertion below iterates the binaries this system
// actually has, so a code path that assumes one binary fails here rather than at publish. It is
// binariesFor(target) and not BINARIES because system-probe is Linux-only and security-agent has no macOS
// build: a package that never carried them must not be failed for missing them.
before(() => {
	({ workDir } = generatePackages({ prefix: "ddab-descriptors-" }));
	packageDir = path.join(workDir, "npm", currentTarget().name);
});

after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test("every binary this system has is packaged, not just the first", () => {
	const mine = binariesFor(currentTarget());
	assert.ok(
		mine.length > 1,
		"the table has collapsed to one entry; this check is now vacuous"
	);
	for (const binary of mine) {
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
	for (const binary of binariesFor(currentTarget())) {
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

// Python is excluded and settled: not because it cannot be shipped, which was disproven, but because
// `runtime/process-metrics.js` produces the one family a Harper node wants and nothing else in
// integrations-core is worth 634 MB a platform. systemd left this flag, because it rode in on python's
// coat-tails with no measurement recorded for it. `src/binaries.ts` carries both halves.
test("the override adds flags and cannot drop the python exclusion", () => {
	const { buildArgs } = require(
		path.join(REPO_ROOT, "dist", "src", "build.js")
	);
	const core = BINARIES.find((b) => b.shipsAs === "datadog-agent");
	assert.ok(core.mandatoryArgs.includes("--build-exclude=python"));

	process.env[core.argsOverride] = "--some-experiment";
	try {
		const args = buildArgs(core);
		assert.ok(
			args.includes("--build-exclude=python"),
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

test("the table spells goos, goarch and exe the way the Go toolchain names them, not the way this package does", () => {
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

// The pin is what makes a build reproducible, and it is also what keeps CI off an unauthenticated
// GitHub API that rate-limits at 60 an hour per IP across every runner.
test("the agent version is pinned in the repo, not resolved from the network", async () => {
	const { pinnedVersion } = require(
		path.join(REPO_ROOT, "dist", "src", "downloader.js")
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

// system-probe and security-agent were absent for reasons that never survived contact. system-probe was
// deleted as collateral in `0c52271`, a commit replacing a hand-written build with upstream's; its cost is
// service discovery, NPM, USM and the ebpf checks, and the core agent logs a socket it cannot reach once a
// minute because of it. security-agent was never in the table at all, and its cost is CWS and CSPM. Neither
// needs python or rtloader: tasks/system_probe.py builds static Go with eBPF and tasks/security_agent.py is
// likewise Go.
test("the table ships the four binaries the agent is, not the two it was", () => {
	assert.deepEqual(
		BINARIES.map((b) => b.shipsAs).sort(),
		["datadog-agent", "security-agent", "system-probe", "trace-agent"],
		"a binary left out of this table is a Datadog capability the package cannot deliver"
	);
});

test("a binary that is not cross-platform says so, and the filter honours it", () => {
	const probe = BINARIES.find((b) => b.shipsAs === "system-probe");
	// Linux only, and deliberately: tasks/system_probe.py's build() skips build_object_files off Linux, so a
	// macOS artifact is a binary with no eBPF in it. Shipping that would imply a capability it lacks.
	assert.deepEqual(probe.onlyOn, ["linux"]);
	const security = BINARIES.find((b) => b.shipsAs === "security-agent");
	assert.deepEqual(security.onlyOn, ["linux", "windows"]);

	const shipsAs = (os) => binariesFor({ os }).map((b) => b.shipsAs);
	assert.ok(shipsAs("linux").includes("system-probe"));
	assert.ok(!shipsAs("macos").includes("system-probe"));
	assert.ok(!shipsAs("macos").includes("security-agent"));
	assert.ok(shipsAs("windows").includes("security-agent"));
	assert.ok(!shipsAs("windows").includes("system-probe"));
});

test("NEGATIVE: the two that are cross-platform stay on every system", () => {
	// A filter that over-reaches would silently stop shipping the agents this package exists for.
	for (const os of ["linux", "macos", "windows"]) {
		const names = binariesFor({ os }).map((b) => b.shipsAs);
		assert.ok(names.includes("datadog-agent"), os);
		assert.ok(names.includes("trace-agent"), os);
	}
});

test("systemd is no longer excluded, and python still is", () => {
	// systemd rode in on python's flag with no measurement or test recorded for it, and cost the journald
	// log source and the systemd integration. Python is settled on its own terms; systemd never had terms.
	const core = BINARIES.find((b) => b.shipsAs === "datadog-agent");
	const excludes = core.mandatoryArgs.filter((a) =>
		a.startsWith("--build-exclude=")
	);
	assert.deepEqual(excludes, ["--build-exclude=python"]);
	assert.ok(!excludes.join(",").includes("systemd"));
});
