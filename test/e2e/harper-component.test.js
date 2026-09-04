import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { test, before, after } = require("node:test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
const { withTempDir } = await import("../support/sandbox.js");

const { currentTarget } = require(
	path.join(REPO_ROOT, "dist", "src", "targets.js")
);
const { BINARIES } = require(
	path.join(REPO_ROOT, "dist", "src", "binaries.js")
);
const { resolveBinary } = await import("../../runtime/binary.js");

const platform = currentTarget();
const platformName = platform.name; // e.g. linux-x86_64
const binaryName = `${BINARIES[0].shipsAs}${platform.exe}`; // datadog-agent[.exe]
const isWindows = process.platform === "win32";

const TRACE_AGENT = "datadog-trace-agent";
const CORE_AGENT = "datadog-agent";

// runtime/binary.js resolves the optional platform package by specifier, so it must live in this repo's
// node_modules- exactly where it would sit as a sibling dependency inside a Harper app's tree.
const platformPkgName = `@harperfast/datadog-agent-binary-${platformName}`;
const platformPkgDir = path.join(REPO_ROOT, "node_modules", platformPkgName);
const stubBinaryPath = path.join(platformPkgDir, "bin", binaryName);

const STUB_MARKER = "STUB_DATADOG_AGENT_OK";
// Marks the package dir as our throwaway fixture so we never delete a real one.
const SENTINEL = path.join(platformPkgDir, ".harper-test-fixture");
// Where a real (npm-installed) platform package is moved while the fixture is
// in place. Once the package is published, `npm ci` installs the matching
// platform package into node_modules, so the fixture must coexist with it.
const BACKUP = `${platformPkgDir}.real-backup`;

function safeRemoveFixture() {
	try {
		fs.rmSync(platformPkgDir, { recursive: true, force: true });
	} catch {
		// Some filesystems (e.g. certain CI/sandbox mounts) disallow unlink.
		// Leaving the fixture behind is harmless: node_modules is ephemeral and
		// createFakePlatformPackage() is idempotent on re-run.
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
 * Write a fake platform sub-package identical in shape to the output of
 * scripts/create-platform-packages.js: a package.json, an index.js exposing
 * getBinaryPath(), and bin/<binaryName>. The "binary" is a tiny script that
 * echoes a marker plus its args so we can prove it was actually executed.
 *
 * Idempotent: if our own fixture is already present it is overwritten; a real
 * installed package (no sentinel) is never touched.
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

	// Stub "agent" binary. A shebang'd Node script works as an executable on
	// Unix; on Windows we still create the file (resolution is tested) but skip
	// the execution assertions below.
	const stub = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
		STUB_MARKER
	)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(0);\n`;
	fs.writeFileSync(stubBinaryPath, stub);
	fs.chmodSync(stubBinaryPath, 0o755);
}

function runToCompletion(child) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		if (child.stdout) child.stdout.on("data", (d) => (stdout += d));
		if (child.stderr) child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

// Held for the whole file, not just one test: the fixture below is a shared, mutable path
// (node_modules/@harperfast/datadog-agent-binary-<platform>) that resolveBinary() also reads from any
// other concurrently-running file, for as long as this fixture is on disk - not only while a given test
// here happens to be running.
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

test("end-to-end: the datadog-agent shim resolves and executes the agent", async (t) => {
	if (isWindows) {
		t.skip("stub executable is not runnable as a .exe on Windows");
		return;
	}
	const shim = path.join(REPO_ROOT, "bin", "datadog-agent");
	const child = spawn(process.execPath, [shim, "version"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	const { code, stdout, stderr } = await runToCompletion(child);
	assert.equal(code, 0, `shim should exit 0 (stderr: ${stderr})`);
	assert.match(
		stdout,
		new RegExp(STUB_MARKER),
		"the resolved agent binary should have actually run"
	);
	assert.match(
		stdout,
		new RegExp(`${STUB_MARKER} version`),
		"user args should reach the agent, not just the shim's own log line"
	);
});

test("NEGATIVE: the shim does not exit 0 for an agent the kernel killed", async (t) => {
	if (isWindows) {
		t.skip("no POSIX signals to kill the stub with");
		return;
	}
	// A signalled child reports exit code null, which `code || 0` turns into success. That is what an OOM
	// kill of the core agent looked like to anything watching the shim.
	const original = fs.readFileSync(stubBinaryPath, "utf8");
	fs.writeFileSync(stubBinaryPath, "#!/bin/sh\nkill -9 $$\n");
	try {
		const shim = path.join(REPO_ROOT, "bin", "datadog-agent");
		const child = spawn(process.execPath, [shim], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		const { code, stderr } = await runToCompletion(child);
		assert.notEqual(
			code,
			0,
			"the shim reported success for a SIGKILLed agent, so a supervisor sees a clean stop"
		);
		assert.match(
			stderr,
			/SIGKILL/,
			"the signal has to reach the log as well as the exit code"
		);
	} finally {
		fs.writeFileSync(stubBinaryPath, original);
		fs.chmodSync(stubBinaryPath, 0o755);
	}
});

test("the bin shim passes the Harper-required `name` option", () => {
	// Regression guard: the spawn call inside the bin shim and the generated
	// wrappers must keep the `name: "datadog-agent"` option.
	const shimSrc = fs.readFileSync(
		path.join(REPO_ROOT, "bin", "datadog-agent"),
		"utf8"
	);
	assert.match(
		shimSrc,
		/name:\s*["']datadog-agent["']/,
		"the bin shim must spawn with a name option or Harper rejects the spawn"
	);
});

test("a binary that resolves to the wrong agent is refused rather than started twice", async () => {
	// The published platform packages predate the trace-agent and answer every request with the core agent.
	// That path exists, so an unchecked resolve starts two core agents and no receiver at all.
	//
	// This depends on build/<platform>/bin holding no trace-agent, which before() establishes two ways: the
	// resolve-binary lock keeps a concurrent file's fixture out, and hideBuiltBinaries moves aside whatever
	// a real `npm run build-agent` left there, which no lock can make absent.
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
		assert.match(
			trace.error,
			/predates trace-agent support/,
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
