"use strict";

/**
 * Descriptor correctness for every supported platform.
 *
 * `AgentBinaryDescriptor` is the single source of truth the builders, the
 * packaging script, and the runtime resolver all read. When it was implicit (one
 * hardcoded binary name threaded through five call sites), the trace-agent
 * went missing from every one of them at once and nothing failed. These
 * assertions are written out as literals rather than derived from
 * `getBinaries()`, so changing the contract requires restating it here.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
const { Platform, SUPPORTED_PLATFORMS, getAllSupportedPlatforms } = require(
	path.join(REPO_ROOT, "dist", "platform.js")
);

/**
 * The `python` build tag links librtloader and an embedded CPython by an rpath
 * into the build tree, producing a core agent that only runs on the machine
 * that built it. `systemd` pulls in libsystemd.
 */
const CORE_BUILD_ARGS = "--build-exclude=systemd,python";

/**
 * Per-kind expectations. `buildStem`/`outputStem` are the extension-free names;
 * the tests append `.exe` themselves on Windows so the extension rule is
 * asserted rather than assumed.
 */
const EXPECTED = {
	core: {
		buildTask: "agent.build",
		buildDir: "agent",
		buildStem: "agent",
		outputStem: "datadog-agent",
		buildArgs: CORE_BUILD_ARGS,
		buildArgsEnvVar: "DD_AGENT_BUILD_ARGS",
		accessorName: "getBinaryPath",
		processName: "datadog-agent",
	},
	trace: {
		buildTask: "trace-agent.build",
		buildDir: "trace-agent",
		buildStem: "trace-agent",
		outputStem: "trace-agent",
		buildArgs: "",
		buildArgsEnvVar: "DD_TRACE_AGENT_BUILD_ARGS",
		accessorName: "getTraceAgentBinaryPath",
		processName: "datadog-trace-agent",
	},
};

const EXPECTED_KINDS = ["core", "trace"];

const EXPECTED_PLATFORM_NAMES = [
	"linux-x86_64",
	"linux-arm64",
	"macos-x86_64",
	"macos-arm64",
	"windows-x86_64",
];

function ext(platform) {
	return platform.getOS() === "windows" ? ".exe" : "";
}

test("SUPPORTED_PLATFORMS is exactly the published platform set", () => {
	assert.deepEqual(
		SUPPORTED_PLATFORMS.map((p) => p.getName()),
		EXPECTED_PLATFORM_NAMES
	);
	assert.deepEqual(getAllSupportedPlatforms(), EXPECTED_PLATFORM_NAMES);
});

test("every supported platform ships exactly the core agent and the trace-agent", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const binaries = platform.getBinaries();
		assert.equal(
			binaries.length,
			2,
			`${platform.getName()} must ship two binaries; a platform that ships only ` +
				`the core agent has no APM receiver and drops every span silently`
		);
		assert.deepEqual(
			binaries.map((b) => b.kind),
			EXPECTED_KINDS,
			`${platform.getName()}: kinds must be core then trace (the core agent is ` +
				`built first and is what getBinaryName() still returns)`
		);
	}
});

test("descriptor fields match the upstream build contract on every platform", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const name = platform.getName();
		const suffix = ext(platform);
		for (const binary of platform.getBinaries()) {
			const expected = EXPECTED[binary.kind];
			assert.ok(expected, `${name}: unexpected binary kind ${binary.kind}`);

			assert.equal(
				binary.buildTask,
				expected.buildTask,
				`${name}/${binary.kind}: buildTask`
			);
			assert.equal(
				binary.buildDir,
				expected.buildDir,
				`${name}/${binary.kind}: buildDir`
			);
			assert.equal(
				binary.buildName,
				`${expected.buildStem}${suffix}`,
				`${name}/${binary.kind}: buildName is what upstream writes to <sourceDir>/bin/${expected.buildDir}/`
			);
			assert.equal(
				binary.outputName,
				`${expected.outputStem}${suffix}`,
				`${name}/${binary.kind}: outputName is the filename published inside the platform package`
			);
			assert.equal(
				binary.buildArgsEnvVar,
				expected.buildArgsEnvVar,
				`${name}/${binary.kind}: buildArgsEnvVar`
			);
			assert.equal(
				binary.accessorName,
				expected.accessorName,
				`${name}/${binary.kind}: accessorName is the function the generated platform package exports`
			);
			assert.equal(
				binary.processName,
				expected.processName,
				`${name}/${binary.kind}: processName is Harper's spawn \`name\` and its PID-lock filename`
			);
		}
	}
});

test("the core agent carries the rtloader/CPython build excludes", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		assert.equal(
			platform.getBinary("core").buildArgs,
			CORE_BUILD_ARGS,
			`${platform.getName()}: without --build-exclude=systemd,python the core agent ` +
				`links an embedded CPython by an rpath into the build tree and only runs on ` +
				`the build machine`
		);
	}
});

test("the trace-agent carries NO build args at all", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const trace = platform.getBinary("trace");
		// Spelled as an equality against "" rather than a falsiness check: the
		// regression this guards against is someone "helpfully" forwarding the core
		// agent's excludes to trace-agent.build. `tasks/trace_agent.py::build()` is a
		// plain go_build with no embedded_path/rtloader_root/exclude_rtloader
		// parameter, and TRACE_AGENT_TAGS contains neither `python` nor `systemd`, so
		// those flags are wrong here, not merely redundant.
		assert.equal(
			trace.buildArgs,
			"",
			`${platform.getName()}: trace-agent.build takes no build excludes. Got ` +
				`"${trace.buildArgs}". The core agent's --build-exclude flags do not apply ` +
				`to a plain go_build and must not be forwarded here.`
		);
		assert.notEqual(
			trace.buildArgsEnvVar,
			platform.getBinary("core").buildArgsEnvVar,
			`${platform.getName()}: core and trace must have separate build-arg env vars, ` +
				`or overriding one silently overrides both`
		);
	}
});

test("Windows binary names end in .exe and no other platform's do", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const isWindows = platform.getOS() === "windows";
		for (const binary of platform.getBinaries()) {
			for (const field of ["buildName", "outputName"]) {
				const value = binary[field];
				assert.equal(
					value.endsWith(".exe"),
					isWindows,
					`${platform.getName()}/${binary.kind}: ${field} = "${value}". .exe is ` +
						`required on Windows and forbidden everywhere else`
				);
			}
		}
	}
});

test("getBinaryName() still returns the core agent, getTraceAgentBinaryName() the trace-agent", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		assert.equal(
			platform.getBinaryName(),
			platform.getBinary("core").outputName,
			`${platform.getName()}: getBinaryName() is the pre-trace-agent API and must keep ` +
				`meaning the core agent, or every existing consumer silently switches binaries`
		);
		assert.equal(
			platform.getTraceAgentBinaryName(),
			platform.getBinary("trace").outputName,
			`${platform.getName()}: getTraceAgentBinaryName()`
		);
		assert.notEqual(
			platform.getBinaryName(),
			platform.getTraceAgentBinaryName(),
			`${platform.getName()}: the two binaries must not share a filename`
		);
	}
});

test("getBinary() returns the descriptor from getBinaries() and throws on an unknown kind", () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const binaries = platform.getBinaries();
		for (const kind of EXPECTED_KINDS) {
			assert.deepEqual(
				platform.getBinary(kind),
				binaries.find((b) => b.kind === kind),
				`${platform.getName()}: getBinary("${kind}") must agree with getBinaries()`
			);
		}
		assert.throws(
			() => platform.getBinary("apm"),
			/No apm binary is defined/,
			`${platform.getName()}: an unknown kind must throw, not return undefined`
		);
	}
});

test("nothing packaging keys off collides between the two descriptors", () => {
	// scripts/create-platform-packages.js has its own guard for this because a
	// collision is silent: two descriptors sharing an accessorName collapse into
	// one property in the generated index.js, and two sharing an outputName have
	// one overwrite the other in bin/. Both look like "the trace-agent is
	// missing" at runtime. Assert it at the source too.
	const unique = [
		"accessorName",
		"outputName",
		"processName",
		"buildDir",
		"buildTask",
	];
	for (const platform of SUPPORTED_PLATFORMS) {
		for (const field of unique) {
			const values = platform.getBinaries().map((b) => b[field]);
			assert.equal(
				new Set(values).size,
				values.length,
				`${platform.getName()}: descriptors share ${field} (${values.join(", ")})`
			);
		}
	}
});

test("getBinaries() hands out a fresh array each call", () => {
	// Callers iterate, filter, and sort this list. A shared array would let one
	// consumer's mutation leak into the next platform-package build.
	const platform = SUPPORTED_PLATFORMS[0];
	const first = platform.getBinaries();
	first.length = 0;
	assert.equal(platform.getBinaries().length, 2);
});

test("Platform.current() describes both binaries for the host", () => {
	const platform = Platform.current();
	assert.deepEqual(
		platform.getBinaries().map((b) => b.kind),
		EXPECTED_KINDS,
		`${platform.getName()} (the host) must resolve both binaries; this is the code ` +
			`path BinaryManager and the bin/ shims take`
	);
});
