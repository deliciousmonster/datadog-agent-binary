/**
 * Resolution and launch behaviour, exercised against a stub platform package in
 * a throwaway sandbox.
 *
 * This file does NOT boot Harper: `assertHarperSpawnAllowed` below is a
 * transcription of v5's spawn gate, not the gate itself. Real enforcement, the
 * PID-file singleton, and ExistingProcessWrapper are covered against a live
 * Harper v5 in test/integration/harper-spawn.test.ts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

import { findFreePort } from '../support/find-free-port.js';
import { PACKAGE_MANIFEST, createDistSandbox, importDist, withEnv } from '../support/harness.js';

const { Platform } = await importDist('platform.js');

const platform = Platform.current();
const PACKAGE_NAME = PACKAGE_MANIFEST.name;
const PACKAGE_SCOPE = PACKAGE_NAME.startsWith('@') ? PACKAGE_NAME.split('/')[0] : '';
const platformPkgName = `${PACKAGE_NAME}-${platform.getName()}`;
const isWindows = process.platform === 'win32';
const SHIM_SKIP = isWindows && 'stub executable is not runnable as a .exe on Windows';

const STUB_MARKER = 'STUB_DATADOG_AGENT_OK';

/**
 * Whether the trace stub binds a receiver, and where. Deliberately not
 * DD_APM_RECEIVER_PORT: the launcher reads that one, and a stub keyed on the same
 * variable could never stand in for an agent that starts and binds nothing, which is
 * the case this file has to be able to produce.
 */
const STUB_RECEIVER_PORT = 'STUB_TRACE_RECEIVER_PORT';

/**
 * What the trace stub does when asked to `run`. It serves one /info and then exits,
 * which is what lets the shim under test terminate; `connection: close` makes that
 * deterministic, because server.close() fires only once the client's socket has ended.
 */
const TRACE_RECEIVER_STUB = `
const stubPort = Number(process.env[${JSON.stringify(STUB_RECEIVER_PORT)}] || 0);
if (stubPort && process.argv.slice(2).includes('run')) {
	const http = require('http');
	const server = http.createServer((request, response) => {
		response.writeHead(request.url === '/info' ? 200 : 404, {
			'content-type': 'application/json',
			connection: 'close',
		});
		response.end(JSON.stringify({ endpoints: ['/v0.3/traces', '/v0.4/traces'] }));
		server.close(() => process.exit(0));
	});
	server.listen(stubPort, '127.0.0.1');
} else {
	process.exit(0);
}
`;

/** Populated by before(): absolute paths inside the sandbox. */
let sandbox;
let sandboxBinaries; // { core: <abs path>, trace: <abs path> }
let BinaryManager;
let launchAgent;
let traceConfigPath;

/**
 * A stub platform package with the shape scripts/create-platform-packages.js
 * generates: one accessor per binary plus the enumerable `binaries` map. Both
 * "binaries" echo a marker, their kind, and their arguments, so an assertion can
 * prove which one actually ran.
 */
function createStubPlatformPackage(packageDir) {
	const binDir = path.join(packageDir, 'bin');
	fs.mkdirSync(binDir, { recursive: true });

	const manifest = {
		name: platformPkgName,
		version: PACKAGE_MANIFEST.version,
		main: 'index.js',
		os: [process.platform],
		cpu: [process.arch],
	};
	fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(manifest, null, '\t'));

	const binaries = platform.getBinaries();
	const accessors = binaries
		.map(
			(b) =>
				`  ${b.accessorName}() {\n` +
				`    return path.join(__dirname, 'bin', ${JSON.stringify(b.outputName)});\n` +
				`  }`
		)
		.join(',\n');
	const map = binaries.map((b) => `    ${b.kind}: ${JSON.stringify(b.outputName)}`).join(',\n');
	fs.writeFileSync(
		path.join(packageDir, 'index.js'),
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
				(binary.kind === 'trace' ? TRACE_RECEIVER_STUB : `process.exit(0);\n`)
		);
		fs.chmodSync(binaryPath, 0o755);
		resolved[binary.kind] = binaryPath;
	}
	return resolved;
}

/** Run one of the sandbox's bin/ shims to completion, capturing its output. */
function runShim(name, args, env = process.env) {
	const child = child_process.spawn(process.execPath, [path.join(sandbox, 'bin', name), ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
	});
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('exit', (code) => resolve({ code, stdout, stderr }));
	});
}

before(async () => {
	// The package scope is shadowed rather than symlinked so the stub platform
	// package below is the one that resolves; bin/ travels because the shim tests
	// execute it.
	sandbox = createDistSandbox({ prefix: 'ddab-harper-', include: ['bin'], shadowed: [PACKAGE_SCOPE] });
	sandboxBinaries = createStubPlatformPackage(path.join(sandbox, 'node_modules', ...platformPkgName.split('/')));

	// The trace launcher refuses to start without an existing config file in a
	// writable directory; a 0-byte file is all the real trace-agent needs too.
	traceConfigPath = path.join(sandbox, 'datadog.yaml');
	fs.writeFileSync(traceConfigPath, '');

	({ BinaryManager } = await importDist('binary-manager.js', sandbox));
	({ launchAgent } = await importDist('agent-launcher.js', sandbox));
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
 * Two details an `Array.includes(command)` approximation gets wrong: the lookup
 * is a Set membership test on the FIRST WHITESPACE-SEPARATED TOKEN of the command
 * (so a binary path containing a space can never match), and the allowlist is
 * checked BEFORE the `name` requirement, so a command failing both reports the
 * allowlist error.
 */
function assertHarperSpawnAllowed(command, options, allowedSpawnCommands) {
	const allowed = new Set(allowedSpawnCommands);
	if (!allowed.has(command.split(' ')[0])) {
		throw new Error(`Command ${command} is not allowed`);
	}
	if (!options?.name) {
		throw new Error(
			`Calling spawn in Harper must have a process "name" in the options to ` +
				`ensure that a single process is started and reused`
		);
	}
}

test('BinaryManager resolves the core agent from the installed platform package', async () => {
	const resolved = await new BinaryManager().ensureBinary();
	assert.equal(resolved, sandboxBinaries.core);
	assert.ok(path.isAbsolute(resolved), 'resolved path must be absolute');
	assert.ok(fs.existsSync(resolved), 'resolved binary must exist on disk');
});

test('BinaryManager resolves the trace-agent from the same platform package', async () => {
	// The defect this package shipped: the platform package installed cleanly,
	// getBinaryPath() resolved, and nothing ever asked for the APM receiver. A
	// core-only resolution now fails here rather than at span-flush time, where it
	// produces no error at all.
	const manager = new BinaryManager();
	const byKind = await manager.ensureBinary('trace');
	assert.equal(byKind, sandboxBinaries.trace);
	assert.ok(fs.existsSync(byKind));

	const byName = await manager.ensureTraceAgentBinary();
	assert.equal(byName, byKind, "ensureTraceAgentBinary() is ensureBinary('trace')");

	assert.notEqual(byKind, await manager.ensureBinary('core'), 'the two kinds must resolve to different files');
});

test('ensureBinary() rejects a version string in the kind slot with an actionable message', async () => {
	// ensureBinary(version) was the old one-argument signature. The CLI's own call site
	// is typechecked, but a JavaScript consumer's is not, so the guard stays.
	await assert.rejects(() => new BinaryManager().ensureBinary('7.75.5'), /first argument.*binary kind/s);
});

test("Harper's allowlist is a Set keyed on the first token of the command", () => {
	const { core: corePath, trace: tracePath } = sandboxBinaries;
	const allowedSpawnCommands = [corePath, tracePath];

	// A bare command name never matches: the allowlist holds absolute paths.
	assert.throws(
		() => assertHarperSpawnAllowed('datadog-agent', { name: 'datadog-agent' }, allowedSpawnCommands),
		/is not allowed/
	);

	for (const [binaryPath, processName] of [
		[corePath, 'datadog-agent'],
		[tracePath, 'datadog-trace-agent'],
	]) {
		assert.doesNotThrow(() => assertHarperSpawnAllowed(binaryPath, { name: processName }, allowedSpawnCommands));
	}

	// split(' ')[0]: arguments appended to the command string are ignored by the
	// lookup, and a path containing a space is truncated at the space and can
	// never match. Both follow from Harper's implementation, not from ours.
	assert.doesNotThrow(() =>
		assertHarperSpawnAllowed(`${corePath} run`, { name: 'datadog-agent' }, allowedSpawnCommands)
	);
	assert.throws(
		() =>
			assertHarperSpawnAllowed('/opt/my apps/datadog-agent', { name: 'datadog-agent' }, ['/opt/my apps/datadog-agent']),
		/is not allowed/,
		'a binary path containing a space cannot be allowlisted; install under a space-free path'
	);
});

test('allowlisting the core agent says nothing about the trace-agent', () => {
	// Exact string equality, per binary. This is the shape the original bug took
	// at the deployment layer: the app allowlisted the one path it knew about.
	assert.throws(
		() => assertHarperSpawnAllowed(sandboxBinaries.trace, { name: 'datadog-trace-agent' }, [sandboxBinaries.core]),
		/is not allowed/,
		'both absolute paths must appear in applications.allowedSpawnCommands'
	);
});

test('Harper requires a `name` option on spawn', () => {
	const binaryPath = sandboxBinaries.core;
	assert.throws(() => assertHarperSpawnAllowed(binaryPath, {}, [binaryPath]), /must have a process "name"/);
	assert.throws(() => assertHarperSpawnAllowed(binaryPath, undefined, [binaryPath]), /must have a process "name"/);
});

test('end-to-end: the datadog-agent shim resolves and executes the core agent', { skip: SHIM_SKIP }, async () => {
	const { code, stdout, stderr } = await runShim('datadog-agent', ['version']);
	assert.equal(code, 0, `shim should exit 0 (stderr: ${stderr})`);
	assert.match(stdout, new RegExp(`${STUB_MARKER} core`), 'the core stub should have run');
	assert.match(stdout, /version/, 'user args should be forwarded to the agent');
});

test('end-to-end: the trace-agent shim resolves and executes the trace-agent', { skip: SHIM_SKIP }, async () => {
	// A port nothing is listening on: the launcher treats an already-bound
	// receiver as a successful no-op and exits 0 without spawning, which would
	// make this assertion pass vacuously on a machine already running APM. The
	// stub binds it after it is spawned, which is what the launcher waits for, so
	// this is also the whole loop: resolve, spawn, observe a receiver, exit 0.
	const port = await findFreePort();
	const { code, stdout, stderr } = await runShim('trace-agent', ['-c', traceConfigPath, 'run'], {
		...process.env,
		DD_APM_RECEIVER_PORT: String(port),
		[STUB_RECEIVER_PORT]: String(port),
	});
	assert.equal(code, 0, `shim should exit 0 (stderr: ${stderr})`);
	assert.match(
		stdout,
		new RegExp(`${STUB_MARKER} trace`),
		'the trace stub should have run; the core stub running here would mean both ' + 'shims launch the same binary'
	);
	assert.match(stdout, /run/, 'user args should be forwarded to the trace-agent');
});

test('NEGATIVE: end-to-end, a trace-agent that never binds exits the shim non-zero', { skip: SHIM_SKIP }, async () => {
	// The founding defect, reproduced through the shipped shim: the binary
	// resolves, the spawn succeeds, the process says "started", and nothing ever
	// serves 8126. Without the stub receiver port the stub echoes and exits 0,
	// which is what upstream does when apm_config.enabled is false.
	const port = await findFreePort();
	const { code, stderr, stdout } = await runShim('trace-agent', ['-c', traceConfigPath, 'run'], {
		...process.env,
		DD_APM_RECEIVER_PORT: String(port),
	});
	assert.match(stdout, new RegExp(`${STUB_MARKER} trace`), 'the trace stub must still have been spawned');
	assert.notEqual(code, 0, 'a launch that produced no receiver must not report success');
	assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${port}`), 'the failure must name the port that stayed unbound');
});

test('end-to-end: a binary without its exec bit is reported as that, not as a bad argument', async (t) => {
	if (isWindows) {
		t.skip('POSIX mode bits do not gate execution on Windows');
		return;
	}
	if (typeof process.getuid === 'function' && process.getuid() === 0) {
		t.skip('root ignores the mode bits this test relies on');
		return;
	}
	// spawn reports EACCES asynchronously, so the launcher prints "Failed to
	// execute" and the operator goes looking at the config. The mode bit is a
	// property of the file npm unpacked, and the message has to say so.
	fs.chmodSync(sandboxBinaries.core, 0o644);
	try {
		const { code, stderr } = await runShim('datadog-agent', ['version']);
		assert.notEqual(code, 0, 'an unexecutable binary must not exit 0');
		assert.match(stderr, /chmod \+x/, `the failure must carry the fix; got: ${stderr}`);
	} finally {
		fs.chmodSync(sandboxBinaries.core, 0o755);
	}
});

/**
 * Run `launchAgent` with `child_process.spawn` replaced, and `process.exit`
 * replaced by a throw so a launcher bailout surfaces as a test failure instead of
 * killing the test runner.
 *
 * The ESM launcher holds `spawn` as a named import binding, which snapshots the
 * builtin's export at link time; mutating the CJS module object alone would leave
 * that binding pointing at the real spawn. syncBuiltinESMExports() re-points the
 * ESM bindings at the patched (and later the restored) function.
 *
 * `onSpawn` runs at the moment of the stubbed spawn, which is the only place a
 * trace test can bring a receiver up: doing it earlier makes the launcher's
 * pre-spawn probe treat APM as already handled and skip the spawn entirely.
 */
async function withStubbedSpawn(fakeChild, run, onSpawn) {
	const realSpawn = child_process.spawn;
	const realExit = process.exit;
	const calls = [];
	child_process.spawn = (command, args, options) => {
		calls.push({ command, args, options });
		onSpawn?.();
		return fakeChild;
	};
	syncBuiltinESMExports();
	process.exit = (code) => {
		throw new Error(`launchAgent called process.exit(${code})`);
	};
	try {
		await run();
	} finally {
		child_process.spawn = realSpawn;
		syncBuiltinESMExports();
		process.exit = realExit;
	}
	return calls;
}

/** An unstarted /info server answering the way a live trace-agent answers. */
function stubReceiver() {
	return http.createServer((request, response) => {
		response.writeHead(request.url === '/info' ? 200 : 404, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ endpoints: ['/v0.4/traces'] }));
	});
}

/** Minimal stand-in for a real ChildProcess. `spawnargs` is what marks it as one. */
function fakeChildProcess() {
	const child = new EventEmitter();
	child.pid = 4242;
	child.spawnargs = [];
	child.unref = () => child;
	return child;
}

test("launchAgent spawns with Harper's required `name`, distinct per binary", async () => {
	const port = await findFreePort();
	await withEnv('DD_APM_RECEIVER_PORT', String(port), async () => {
		const coreCalls = await withStubbedSpawn(fakeChildProcess(), () => launchAgent('core', ['version']));
		assert.equal(coreCalls.length, 1);
		assert.equal(coreCalls[0].command, sandboxBinaries.core);
		assert.deepEqual(coreCalls[0].args, ['version']);
		assert.equal(
			coreCalls[0].options.name,
			'datadog-agent',
			'Harper throws on a spawn with no `name`, and uses it as the PID-lock filename'
		);

		const receiver = stubReceiver();
		try {
			const traceCalls = await withStubbedSpawn(
				fakeChildProcess(),
				() => launchAgent('trace', ['-c', traceConfigPath, 'run']),
				() => receiver.listen(port, '127.0.0.1')
			);
			assert.equal(traceCalls.length, 1);
			assert.equal(traceCalls[0].command, sandboxBinaries.trace);
			assert.equal(
				traceCalls[0].options.name,
				'datadog-trace-agent',
				"the two processes must take different PID locks, or Harper's dedupe lets " + 'only one of them run per node'
			);
		} finally {
			await new Promise((resolve) => receiver.close(resolve));
		}
	});
});

test('launchAgent unrefs and returns when Harper hands back an existing process', async () => {
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

	const calls = await withStubbedSpawn(wrapper, () => launchAgent('core', ['run']));
	assert.equal(calls.length, 1);
	assert.equal(unrefCalls, 1, "the launcher must unref the wrapper's liveness interval");
});
