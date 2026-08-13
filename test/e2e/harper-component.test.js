"use strict";

/**
 * Resolution and launch behaviour, exercised against a stub platform package in
 * a throwaway sandbox.
 *
 * Two things changed from the version of this file that only knew about the core
 * agent:
 *
 *  1. The fixture no longer writes into the repo's own node_modules. It used to
 *     move the real platform package aside and restore it in an `after()` hook,
 *     so a crashed run left a stub "agent" in the developer's tree and the real
 *     package parked under a .real-backup suffix. The sandbox below is a temp
 *     directory holding copies of dist/ and bin/ plus its own node_modules, so
 *     resolution happens entirely inside it and a hard kill leaves the repo
 *     untouched.
 *
 *  2. The Harper spawn model matches security/jsLoader.ts instead of
 *     approximating it: the allowlist is a Set keyed on `command.split(' ')[0]`,
 *     checked before the `name` requirement.
 *
 * This file does NOT boot Harper. Real spawn enforcement, the PID-file
 * singleton, and ExistingProcessWrapper are covered against a real Harper v5
 * instance in test/integration/harper-spawn.test.ts.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const child_process = require("node:child_process");
const { EventEmitter } = require("node:events");

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
const REPO_VERSION = require(path.join(REPO_ROOT, "package.json")).version;
const { Platform } = require(path.join(REPO_ROOT, "dist", "platform.js"));

const platform = Platform.current();
const platformName = platform.getName();
// Derived from the manifest, not hardcoded: the package scope is a single source of
// truth in package.json, and a test that pins the old scope would pass against a stale
// assumption after a re-scope.
const PACKAGE_NAME = require(path.join(REPO_ROOT, "package.json")).name;
const PACKAGE_SCOPE = PACKAGE_NAME.startsWith("@")
	? PACKAGE_NAME.split("/")[0]
	: "";
const platformPkgName = `${PACKAGE_NAME}-${platformName}`;
const isWindows = process.platform === "win32";

const STUB_MARKER = "STUB_DATADOG_AGENT_OK";

/** Populated by before(): absolute paths inside the sandbox. */
let sandbox;
let sandboxBinaries; // { core: <abs path>, trace: <abs path> }
let BinaryManager;
let launchAgent;
let traceConfigPath;

/**
 * Symlink every top-level entry of the repo's node_modules into the sandbox so
 * dist/ can load its runtime dependencies (chalk, node-fetch) from there, then
 * shadow the package scope with a real directory holding only our stub.
 *
 * Shadowing the scope rather than symlinking it is the point: on a machine where
 * the real platform package is installed, symlinking the scope would let the
 * real package win and the stub would never be exercised.
 */
function linkRuntimeDependencies(sourceModules, targetModules) {
	fs.mkdirSync(targetModules, { recursive: true });
	for (const entry of fs.readdirSync(sourceModules)) {
		if (entry === PACKAGE_SCOPE) continue;
		const source = path.join(sourceModules, entry);
		if (!fs.statSync(source).isDirectory()) continue;
		// "junction" is the only directory link Windows creates without elevation.
		fs.symlinkSync(
			source,
			path.join(targetModules, entry),
			isWindows ? "junction" : "dir"
		);
	}
}

/**
 * A stub platform package with the exact shape scripts/create-platform-packages.js
 * generates: one accessor per binary plus the enumerable `binaries` map. Both
 * "binaries" are shebang'd Node scripts that echo a marker, their kind, and their
 * arguments, so an assertion can prove which one actually ran.
 */
function createStubPlatformPackage(packageDir) {
	const binDir = path.join(packageDir, "bin");
	fs.mkdirSync(binDir, { recursive: true });

	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify(
			{
				name: platformPkgName,
				version: REPO_VERSION,
				main: "index.js",
				os: [process.platform],
				cpu: [process.arch],
			},
			null,
			"\t"
		)
	);

	const binaries = platform.getBinaries();
	const accessors = binaries
		.map(
			(b) =>
				`  ${b.accessorName}() {\n` +
				`    return path.join(__dirname, 'bin', ${JSON.stringify(b.outputName)});\n` +
				`  }`
		)
		.join(",\n");
	const map = binaries
		.map((b) => `    ${b.kind}: ${JSON.stringify(b.outputName)}`)
		.join(",\n");
	fs.writeFileSync(
		path.join(packageDir, "index.js"),
		`const path = require('path');\n\nmodule.exports = {\n${accessors},\n  binaries: {\n${map}\n  }\n};\n`
	);

	const resolved = {};
	for (const binary of binaries) {
		const binaryPath = path.join(binDir, binary.outputName);
		fs.writeFileSync(
			binaryPath,
			`#!/usr/bin/env node\n` +
				`process.stdout.write(${JSON.stringify(STUB_MARKER)} + ' ' + ` +
				`${JSON.stringify(binary.kind)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n` +
				`process.exit(0);\n`
		);
		fs.chmodSync(binaryPath, 0o755);
		resolved[binary.kind] = binaryPath;
	}
	return resolved;
}

/** A port nothing is listening on, so the trace launcher's already-running probe says no. */
function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
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

before(() => {
	// realpath so paths compared against __dirname-derived values agree on macOS,
	// where os.tmpdir() is a symlink into /private.
	sandbox = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ddab-harper-"))
	);
	fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(sandbox, "dist"), {
		recursive: true,
	});
	fs.cpSync(path.join(REPO_ROOT, "bin"), path.join(sandbox, "bin"), {
		recursive: true,
	});
	linkRuntimeDependencies(
		path.join(REPO_ROOT, "node_modules"),
		path.join(sandbox, "node_modules")
	);
	sandboxBinaries = createStubPlatformPackage(
		path.join(
			sandbox,
			"node_modules",
			PACKAGE_SCOPE,
			`datadog-agent-binary-${platformName}`
		)
	);

	// The trace launcher refuses to start without an existing config file in a
	// writable directory; a 0-byte file is all the real trace-agent needs too.
	traceConfigPath = path.join(sandbox, "datadog.yaml");
	fs.writeFileSync(traceConfigPath, "");

	({ BinaryManager } = require(
		path.join(sandbox, "dist", "binary-manager.js")
	));
	({ launchAgent } = require(path.join(sandbox, "dist", "agent-launcher.js")));
});

after(() => {
	if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Harper v5's spawn gate, transcribed from security/jsLoader.ts `createSpawn()`.
 *
 *   if (!ALLOWED_COMMANDS.has(command.split(' ')[0])) throw ...
 *   if (!options?.name) throw ...
 *
 * ALLOWED_COMMANDS is `new Set(applications.allowedSpawnCommands ?? [])`. Two
 * details this reproduces that an `Array.includes(command)` approximation gets
 * wrong: the lookup is a Set membership test on the FIRST WHITESPACE-SEPARATED
 * TOKEN of the command (so a binary path containing a space can never match),
 * and the allowlist is checked BEFORE the `name` requirement, so a command that
 * fails both reports the allowlist error.
 */
function assertHarperSpawnAllowed(command, options, allowedSpawnCommands) {
	const allowed = new Set(allowedSpawnCommands);
	if (!allowed.has(command.split(" ")[0])) {
		throw new Error(`Command ${command} is not allowed`);
	}
	if (!options?.name) {
		throw new Error(
			`Calling spawn in Harper must have a process "name" in the options to ` +
				`ensure that a single process is started and reused`
		);
	}
}

test("BinaryManager resolves the core agent from the installed platform package", async () => {
	const resolved = await new BinaryManager().ensureBinary();
	assert.equal(resolved, sandboxBinaries.core);
	assert.ok(path.isAbsolute(resolved), "resolved path must be absolute");
	assert.ok(fs.existsSync(resolved), "resolved binary must exist on disk");
});

test("BinaryManager resolves the trace-agent from the same platform package", async () => {
	// The defect this package shipped: the platform package installed cleanly,
	// getBinaryPath() resolved, and nothing ever asked for the APM receiver. A
	// core-only resolution now has to fail here rather than at span-flush time,
	// where it produces no error at all.
	const manager = new BinaryManager();
	const byKind = await manager.ensureBinary("trace");
	assert.equal(byKind, sandboxBinaries.trace);
	assert.ok(fs.existsSync(byKind));

	const byName = await manager.ensureTraceAgentBinary();
	assert.equal(
		byName,
		byKind,
		"ensureTraceAgentBinary() is ensureBinary('trace')"
	);

	assert.notEqual(
		byKind,
		await manager.ensureBinary("core"),
		"the two kinds must resolve to different files"
	);
});

test("ensureBinary() rejects a version string in the kind slot with an actionable message", async () => {
	// ensureBinary(version) was the old one-argument signature; commander types
	// its options as `any`, so a stale call site typechecks and fails at runtime.
	await assert.rejects(
		() => new BinaryManager().ensureBinary("7.75.5"),
		/first argument.*binary kind/s
	);
});

test("Harper's allowlist is a Set keyed on the first token of the command", async () => {
	const manager = new BinaryManager();
	const corePath = await manager.ensureBinary("core");
	const tracePath = await manager.ensureBinary("trace");
	const allowedSpawnCommands = [corePath, tracePath];

	// A bare command name never matches: the allowlist holds absolute paths.
	assert.throws(
		() =>
			assertHarperSpawnAllowed(
				"datadog-agent",
				{ name: "datadog-agent" },
				allowedSpawnCommands
			),
		/is not allowed/
	);

	for (const [binaryPath, processName] of [
		[corePath, "datadog-agent"],
		[tracePath, "datadog-trace-agent"],
	]) {
		assert.doesNotThrow(() =>
			assertHarperSpawnAllowed(
				binaryPath,
				{ name: processName },
				allowedSpawnCommands
			)
		);
	}

	// split(' ')[0]: arguments appended to the command string are ignored by the
	// lookup, and a path containing a space is truncated at the space and can
	// never match. Both follow from Harper's implementation, not from ours.
	assert.doesNotThrow(() =>
		assertHarperSpawnAllowed(
			`${corePath} run`,
			{ name: "datadog-agent" },
			allowedSpawnCommands
		)
	);
	assert.throws(
		() =>
			assertHarperSpawnAllowed(
				"/opt/my apps/datadog-agent",
				{ name: "datadog-agent" },
				["/opt/my apps/datadog-agent"]
			),
		/is not allowed/,
		"a binary path containing a space cannot be allowlisted; install under a space-free path"
	);
});

test("allowlisting the core agent says nothing about the trace-agent", async () => {
	// Exact string equality, per binary. This is the shape the original bug took
	// at the deployment layer: the app allowlisted the one path it knew about.
	const manager = new BinaryManager();
	const corePath = await manager.ensureBinary("core");
	const tracePath = await manager.ensureBinary("trace");

	assert.throws(
		() =>
			assertHarperSpawnAllowed(tracePath, { name: "datadog-trace-agent" }, [
				corePath,
			]),
		/is not allowed/,
		"both absolute paths must appear in applications.allowedSpawnCommands"
	);
});

test("Harper requires a `name` option on spawn", async () => {
	const binaryPath = await new BinaryManager().ensureBinary();
	assert.throws(
		() => assertHarperSpawnAllowed(binaryPath, {}, [binaryPath]),
		/must have a process "name"/
	);
	assert.throws(
		() => assertHarperSpawnAllowed(binaryPath, undefined, [binaryPath]),
		/must have a process "name"/
	);
});

test("end-to-end: the datadog-agent shim resolves and executes the core agent", async (t) => {
	if (isWindows) {
		t.skip("stub executable is not runnable as a .exe on Windows");
		return;
	}
	const shim = path.join(sandbox, "bin", "datadog-agent");
	const child = child_process.spawn(process.execPath, [shim, "version"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	const { code, stdout, stderr } = await runToCompletion(child);
	assert.equal(code, 0, `shim should exit 0 (stderr: ${stderr})`);
	assert.match(
		stdout,
		new RegExp(`${STUB_MARKER} core`),
		"the core stub should have run"
	);
	assert.match(stdout, /version/, "user args should be forwarded to the agent");
});

test("end-to-end: the trace-agent shim resolves and executes the trace-agent", async (t) => {
	if (isWindows) {
		t.skip("stub executable is not runnable as a .exe on Windows");
		return;
	}
	const shim = path.join(sandbox, "bin", "trace-agent");
	// A port nothing is listening on: the launcher treats an already-bound
	// receiver as a successful no-op and exits 0 without spawning, which would
	// make this assertion pass vacuously on a machine already running APM.
	const port = await findFreePort();
	const child = child_process.spawn(
		process.execPath,
		[shim, "-c", traceConfigPath, "run"],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, DD_APM_RECEIVER_PORT: String(port) },
		}
	);
	const { code, stdout, stderr } = await runToCompletion(child);
	assert.equal(code, 0, `shim should exit 0 (stderr: ${stderr})`);
	assert.match(
		stdout,
		new RegExp(`${STUB_MARKER} trace`),
		"the trace stub should have run; the core stub running here would mean both " +
			"shims launch the same binary"
	);
	assert.match(
		stdout,
		/run/,
		"user args should be forwarded to the trace-agent"
	);
});

/**
 * Run `launchAgent` with `child_process.spawn` replaced, and with `process.exit`
 * replaced by a throw so a launcher bailout surfaces as a test failure instead of
 * killing the test runner.
 *
 * The compiled launcher calls `(0, child_process_1.spawn)(...)`, a property read
 * at call time, so patching the builtin module object here is enough.
 */
async function withStubbedSpawn(fakeChild, run) {
	const realSpawn = child_process.spawn;
	const realExit = process.exit;
	const calls = [];
	child_process.spawn = (command, args, options) => {
		calls.push({ command, args, options });
		return fakeChild;
	};
	process.exit = (code) => {
		throw new Error(`launchAgent called process.exit(${code})`);
	};
	try {
		await run();
	} finally {
		child_process.spawn = realSpawn;
		process.exit = realExit;
	}
	return calls;
}

/** Minimal stand-in for a real ChildProcess. `spawnargs` is what marks it as one. */
function fakeChildProcess(pid = 4242) {
	const child = new EventEmitter();
	child.pid = pid;
	child.spawnargs = [];
	child.unref = () => child;
	return child;
}

test("launchAgent spawns with Harper's required `name`, distinct per binary", async () => {
	// This is the assertion the shipped wrappers used to carry as a source grep
	// for the literal `name: "datadog-agent"`. Executing the launcher covers the
	// same regression and keeps working when the value stops being a literal.
	const port = await findFreePort();
	const previousPort = process.env.DD_APM_RECEIVER_PORT;
	process.env.DD_APM_RECEIVER_PORT = String(port);
	try {
		const coreCalls = await withStubbedSpawn(fakeChildProcess(), () =>
			launchAgent("core", ["version"])
		);
		assert.equal(coreCalls.length, 1);
		assert.equal(coreCalls[0].command, sandboxBinaries.core);
		assert.deepEqual(coreCalls[0].args, ["version"]);
		assert.equal(
			coreCalls[0].options.name,
			"datadog-agent",
			"Harper throws on a spawn with no `name`, and uses it as the PID-lock filename"
		);

		const traceCalls = await withStubbedSpawn(fakeChildProcess(), () =>
			launchAgent("trace", ["-c", traceConfigPath, "run"])
		);
		assert.equal(traceCalls.length, 1);
		assert.equal(traceCalls[0].command, sandboxBinaries.trace);
		assert.equal(
			traceCalls[0].options.name,
			"datadog-trace-agent",
			"the two processes must take different PID locks, or Harper's dedupe lets " +
				"only one of them run per node"
		);
	} finally {
		if (previousPort === undefined) delete process.env.DD_APM_RECEIVER_PORT;
		else process.env.DD_APM_RECEIVER_PORT = previousPort;
	}
});

test("launchAgent unrefs and returns when Harper hands back an existing process", async () => {
	// Every loser of Harper's PID-file race gets an ExistingProcessWrapper: an
	// EventEmitter with pid/kill/unref and no stdio and no spawnargs. Its 1Hz
	// liveness interval is not unref'd, so a thread that joined an existing
	// process never goes idle unless the launcher unrefs the handle. Exiting on
	// this path would kill a Harper worker thread.
	let unrefCalls = 0;
	const wrapper = new EventEmitter();
	wrapper.pid = 9999;
	wrapper.kill = () => true;
	wrapper.unref = () => {
		unrefCalls++;
		return wrapper;
	};
	assert.equal(wrapper.spawnargs, undefined);
	assert.equal(wrapper.stdout, undefined);

	const calls = await withStubbedSpawn(wrapper, () =>
		launchAgent("core", ["run"])
	);
	assert.equal(calls.length, 1);
	assert.equal(
		unrefCalls,
		1,
		"the launcher must unref the wrapper's liveness interval"
	);
});
