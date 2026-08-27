/**
 * What is left in the launcher once the receiver probe moved out of it:
 * `describeSpawnFailure()`, `isRunSubcommand()` and `onExit()`. Each guards a
 * failure mode that surfaces only as silently dropped spans; they are reached
 * through the launcher's `internalsForTesting` export. The probe itself is
 * covered by test/unit/trace-receiver.test.js.
 *
 * Hermetic: the only sockets are ephemeral 127.0.0.1 listeners standing in for
 * a receiver, the same device test/e2e/harper-component.test.js uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findFreePort } from '../support/find-free-port.js';
import { importDist, withReceiver, withReceiverPort } from '../support/harness.js';

const { describeSpawnFailure, isRunSubcommand, onExit } = (await importDist('agent-launcher.js')).internalsForTesting;
const { Platform } = await importDist('platform.js');

/**
 * Run `onExit` with `process.exit` replaced by a throw, and return the exit
 * code. The throw matters: a real exit never returns, and a stub that returns
 * would let the code fall through into branches that cannot execute in
 * production.
 */
async function exitCodeFrom(run) {
	class ExitCall extends Error {
		constructor(code) {
			super(`process.exit(${code})`);
			this.code = code ?? 0;
		}
	}
	const realExit = process.exit;
	process.exit = (code) => {
		throw new ExitCall(code);
	};
	try {
		await run();
		throw new Error('onExit returned without calling process.exit');
	} catch (error) {
		if (error instanceof ExitCall) return error.code;
		throw error;
	} finally {
		process.exit = realExit;
	}
}

test('a wrong-architecture binary is diagnosed as one', () => {
	// ENOEXEC arrives as "Failed to execute", which reads like a bad argument and
	// sends people to the config. npm's os/cpu gate covers the install; nothing
	// covers a build leg that filled one platform's bin/ from another's runner.
	const message = describeSpawnFailure({ code: 'ENOEXEC' }, '/pkg/bin/trace-agent');
	assert.ok(message.includes('/pkg/bin/trace-agent'));
	assert.ok(
		message.includes(Platform.current().getName()),
		`the message must name the architecture that was expected; got: ${message}`
	);
});

test('a binary without its exec bit is diagnosed as one', () => {
	const message = describeSpawnFailure({ code: 'EACCES' }, '/pkg/bin/trace-agent');
	assert.match(message, /chmod \+x/, 'the message must carry the fix, not just the errno');
});

test('NEGATIVE: an unrelated spawn failure gets no invented diagnosis', () => {
	// A guess dressed as a diagnosis is worse than the errno: it describes a world
	// that is not the one that failed.
	for (const error of [{ code: 'ENOENT' }, new Error('boom'), undefined, null]) {
		assert.equal(describeSpawnFailure(error, '/pkg/bin/trace-agent'), null, JSON.stringify(error));
	}
});

test('isRunSubcommand() treats a bare invocation and `run` as the receiver', () => {
	assert.equal(isRunSubcommand([]), true);
	assert.equal(isRunSubcommand(['run']), true);
});

test('short-lived queries are not mistaken for the receiver', () => {
	// `version` while a receiver is up must not be swallowed by the
	// already-running check; misclassifying it exits 0 without running anything.
	assert.equal(isRunSubcommand(['version']), false);
	assert.equal(isRunSubcommand(['status']), false);
	// Help exits after printing. Classified as the receiver it would be held open
	// waiting for a bind that is never coming, and then fail the invocation.
	assert.equal(isRunSubcommand(['-h']), false);
	assert.equal(isRunSubcommand(['--help']), false);
});

test('a flag value is not read as the subcommand', () => {
	// `-c <path> run` is the shape the shim's own e2e test uses. Reading <path> as
	// the subcommand makes every receiver check here skip itself, silently, on the
	// one invocation that binds the socket.
	assert.equal(isRunSubcommand(['-c', '/etc/datadog.yaml', 'run']), true);
	assert.equal(isRunSubcommand(['--pidfile', '/run/trace.pid', 'run']), true);
	assert.equal(isRunSubcommand(['-c=/etc/datadog.yaml', 'run']), true);
	// The value is skipped, not blindly consumed: a query after one stays a query.
	assert.equal(isRunSubcommand(['-c', '/etc/datadog.yaml', 'version']), false);
});

test('NEGATIVE: a trace-agent that exits 0 having never bound is a failed launch', async () => {
	// The founding defect with green output. Measured against the shipped 7.82.1
	// binary, `trace-agent run` with apm_config.enabled false exits 0 and binds
	// nothing, so the exit code alone cannot carry this claim.
	const port = await findFreePort();
	assert.equal(
		await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', 0, null, { port, bound: false })),
		1,
		'a run that never served the receiver must not report success'
	);
});

test('a receiver that served and then stopped exits 0', async () => {
	// The other direction, and the one that matters more: a check that refuses a
	// launch which worked is worse than no check.
	const port = await findFreePort();
	assert.equal(await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', 0, null, { port, bound: true })), 0);
});

test('onExit() treats a requested stop as a clean stop', async () => {
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
		assert.equal(await exitCodeFrom(() => onExit('core', 'datadog-agent', null, signal)), 0, signal);
	}
});

test('NEGATIVE: a crash or an OOM kill does not exit 0', async () => {
	// The OOM killer takes the trace-agent and the wrapper reports success, so a
	// container restart policy, a shell `&&`, or a systemd unit sees a clean stop.
	// SIGKILL is 9 wherever Node reports it, so the 128 + signum convention is pinned
	// on that one. The rest are only required to be non-zero: Windows numbers SIGABRT
	// 22 rather than 6 and does not define SIGBUS at all, and asserting the arithmetic
	// against os.constants would be asserting the implementation against itself.
	assert.equal(await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', null, 'SIGKILL')), 137);
	for (const signal of ['SIGSEGV', 'SIGABRT', 'SIGBUS']) {
		const code = await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', null, signal));
		assert.notEqual(code, 0, `${signal} was reported as a clean stop`);
	}
});

test('onExit() passes a clean exit through', async () => {
	assert.equal(await exitCodeFrom(() => onExit('core', 'datadog-agent', 0, null)), 0);
});

test('a failing core agent exits non-zero; no receiver probe applies', async () => {
	assert.equal(await exitCodeFrom(() => onExit('core', 'datadog-agent', 1, null)), 1);
});

test('trace rc=1 with a healthy receiver on the port is already-running', () =>
	withReceiver({ body: { endpoints: ['/v0.4/traces'] } }, (port) =>
		withReceiverPort(String(port), async () => {
			assert.equal(
				await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', 1, null)),
				0,
				'EADDRINUSE against a live receiver means APM is served; rc must be 0'
			);
		})
	));

test('trace rc=1 with nothing on the port stays a failure', async () => {
	const port = await findFreePort();
	await withReceiverPort(String(port), async () => {
		assert.equal(
			await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', 1, null)),
			1,
			'a startup failure with no receiver present must not be reported as success'
		);
	});
});

test('trace rc=1 next to an unrelated listener stays a failure', () =>
	// The regression guarded here: a bare port check cannot tell EADDRINUSE
	// against a real receiver from a misconfigured agent dying beside a stray
	// socket, and the latter must stay loud.
	withReceiver({ body: { endpoints: ['/health'] } }, (port) =>
		withReceiverPort(String(port), async () => {
			assert.equal(await exitCodeFrom(() => onExit('trace', 'datadog-trace-agent', 1, null)), 1);
		})
	));
