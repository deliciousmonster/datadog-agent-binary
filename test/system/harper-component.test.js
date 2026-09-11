import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { test, before, after } = require("node:test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Lives here, not beside the other supervisor tests, because it needs the platform-package fixture
// this file plants in the repo's real node_modules. That fixture is global, so it cannot be shared.
const {
	loadComponent,
	recordingScope,
	REPO_ROOT,
	acquireResolveBinaryLock,
	hideBuiltBinaries,
	start,
} = await import("../support/component.js");
const { findFreePort } = await import("../support/loopback.js");
const { CORE_AGENT, TRACE_AGENT } = await import("../support/agents.js");
const { withTempDir } = await import("../support/sandbox.js");

const { currentTarget } = require(
	path.join(REPO_ROOT, "agent-build", "toolchain.js")
);
const { BINARIES } = require(
	path.join(REPO_ROOT, "agent-build", "binaries.js")
);
const { resolveBinary } = await import("../../runtime/datadog.js");

const platform = currentTarget();
const platformName = platform.name; // e.g. linux-x86_64
const binaryName = `${BINARIES[0].shipsAs}${platform.exe}`; // datadog-agent[.exe]
// the resolver names the file it looked for, suffix and all, so an assertion on that message has to
// carry the same suffix or it only ever holds where the platform has none.
const traceBinaryName = `${BINARIES[1].shipsAs}${platform.exe}`; // trace-agent[.exe]

// runtime/datadog.js resolves the optional platform package by specifier, so it must live in this repo's
// node_modules- exactly where it would sit as a sibling dependency inside a Harper app's tree.
const platformPkgName = `@deliciousmonster/datadog-agent-binary-${platformName}`;
const platformPkgDir = path.join(REPO_ROOT, "node_modules", platformPkgName);
const stubBinaryPath = path.join(platformPkgDir, "bin", binaryName);

const STUB_MARKER = "STUB_DATADOG_AGENT_OK";
// Marks the package dir as our throwaway fixture so we never delete a real one.
const SENTINEL = path.join(platformPkgDir, ".harper-test-fixture");
// Where a real (npm-installed) platform package is moved while the fixture is in place.
const BACKUP = `${platformPkgDir}.real-backup`;

function safeRemoveFixture() {
	try {
		fs.rmSync(platformPkgDir, { recursive: true, force: true });
	} catch {
		// Some filesystems (e.g. certain CI/sandbox mounts) disallow unlink. Leaving the fixture behind is harmless:
		// node_modules is ephemeral and createFakePlatformPackage() is idempotent on re-run.
	}
	// Restore the real package we moved aside (if any).
	if (fs.existsSync(BACKUP)) {
		try {
			fs.renameSync(BACKUP, platformPkgDir);
		} catch {
			/* best effort */
		}
	}
	try {
		const scopeDir = path.dirname(platformPkgDir);
		if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
			fs.rmdirSync(scopeDir);
		}
	} catch {
		/* ignore */
	}
}

/**
 * Write a fake platform sub-package identical in shape to the output of the kit's staging: a package.json, an
 * index.js exposing getBinaryPath(), and bin/<binaryName>.
 */
function createFakePlatformPackage() {
	if (fs.existsSync(platformPkgDir) && !fs.existsSync(SENTINEL)) {
		// A real (npm-installed) platform package is here- move it aside and
		// restore it in teardown, rather than clobbering it.
		fs.rmSync(BACKUP, { recursive: true, force: true });
		fs.renameSync(platformPkgDir, BACKUP);
	}

	fs.mkdirSync(path.join(platformPkgDir, "bin"), { recursive: true });
	fs.writeFileSync(SENTINEL, "");

	fs.writeFileSync(
		path.join(platformPkgDir, "package.json"),
		JSON.stringify(
			{
				name: platformPkgName,
				version: require(path.join(REPO_ROOT, "package.json")).version,
				main: "index.js",
				os: [platform.os],
				cpu: [platform.arch],
			},
			null,
			"\t"
		)
	);

	fs.writeFileSync(
		path.join(platformPkgDir, "index.js"),
		`const path = require('path');\nmodule.exports = {\n  getBinaryPath() {\n    return path.join(__dirname, 'bin', ${JSON.stringify(binaryName)});\n  }\n};\n`
	);

	// Stub "agent" binary. A shebang'd Node script works as an executable on Unix; on Windows we still create the
	// file (resolution is tested) but skip the execution assertions below.
	const stub = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
		STUB_MARKER
	)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(0);\n`;
	fs.writeFileSync(stubBinaryPath, stub);
	fs.chmodSync(stubBinaryPath, 0o755);
}

// Held for the whole file: the fixture below is a shared, mutable path under node_modules that every
// concurrently-running suite's resolveBinary() reads for as long as it is on disk.
let releaseResolveBinaryLock;
let restoreBuiltBinaries;

before(async () => {
	releaseResolveBinaryLock = await acquireResolveBinaryLock();
	// The wrong-agent test below needs build/<platform>/bin to hold no trace-agent. The lock keeps other
	// fixtures out of that path; only this makes it empty on a checkout that has run `npm run build-agent`.
	restoreBuiltBinaries = hideBuiltBinaries();
	createFakePlatformPackage();
});

after(() => {
	safeRemoveFixture();
	restoreBuiltBinaries();
	releaseResolveBinaryLock();
});

test("the installed platform package is preferred over a local build (no network, no build)", async () => {
	const resolved = await resolveBinary({
		shipsAs: BINARIES[0].shipsAs,
		title: "core agent",
	});
	assert.equal(
		resolved,
		stubBinaryPath,
		"the resolver did not take the platform package's getBinaryPath()"
	);
	assert.ok(path.isAbsolute(resolved), "resolved path must be absolute");
	assert.ok(fs.existsSync(resolved), "resolved binary must exist on disk");
});

test("a binary that resolves to the wrong agent is refused rather than started twice", async () => {
	// The published platform packages predate the trace-agent and answer every request with the core agent. That
	// path exists, so an unchecked resolve starts two core agents and no receiver at all.
	const receiver = await findFreePort();
	const expvarPort = await findFreePort();
	await withTempDir("dd-runtime-", async (root) => {
		const scope = recordingScope({ state: { exited: true } });
		const { status } = await start(scope, {
			ROOTPATH: root,
			DD_APM_RECEIVER_PORT: String(receiver),
			DD_EXPVAR_PORT: String(expvarPort),
		});
		const trace = status.processes.find((state) => state.name === TRACE_AGENT);

		assert.equal(
			trace.started,
			false,
			"the trace-agent started from a path that resolves the core agent"
		);
		assert.ok(
			trace.error.includes(`predates ${traceBinaryName} support`),
			`the error must name the real cause (a stale platform package), not a generic "could not resolve": ${trace.error}`
		);
		assert.match(
			trace.error,
			/npm run build-agent/,
			`an operator reading this needs the fix, not just the diagnosis: ${trace.error}`
		);
		assert.deepEqual(
			scope.starts.map((options) => options.name),
			[CORE_AGENT],
			"only the agent whose binary actually resolved may be handed to Harper"
		);
	});
});
