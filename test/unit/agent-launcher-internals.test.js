/**
 * The launcher's supervision internals: `receiverPort()`, `isRunSubcommand()`,
 * `isTraceReceiverHealthy()`, and `onExit()`. Each guards a failure mode that
 * surfaces only as silently dropped spans; they are reached through the
 * launcher's `internalsForTesting` export.
 *
 * Hermetic: the only sockets are ephemeral 127.0.0.1 listeners standing in for
 * a receiver, the same device test/e2e/harper-component.test.js uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { findFreePort } from '../support/find-free-port.js';
import { importDist, withEnv } from '../support/harness.js';

const { receiverPort, isRunSubcommand, isTraceReceiverHealthy, onExit } = (await importDist('agent-launcher.js'))
	.internalsForTesting;

/** The one variable every test here turns. */
const withReceiverPort = (value, run) => withEnv('DD_APM_RECEIVER_PORT', value, run);

/** `run` against a server listening on an ephemeral 127.0.0.1 port. */
async function withServer(server, run) {
	const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
	try {
		return await run(port);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

/**
 * An HTTP stub answering only /info with `body`, or with a raw non-JSON
 * payload. Any other path 404s: the probe URL is part of the contract under
 * test, and a stub that answers everything lets a probe-path typo pass.
 */
function withReceiver({ status = 200, body, raw, path = '/info' } = {}, run) {
	return withServer(
		http.createServer((request, response) => {
			if (request.url !== path) {
				response.writeHead(404, { 'content-type': 'application/json' });
				response.end('{}');
				return;
			}
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(raw ?? JSON.stringify(body ?? {}));
		}),
		run
	);
}

/** `fn` with console.warn captured, which is where the launcher's logger writes. */
async function captureWarnings(fn) {
	const warnings = [];
	const realWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(' '));
	try {
		await fn();
	} finally {
		console.warn = realWarn;
	}
	return warnings;
}

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

test('receiverPort() defaults to 8126, the port dd-trace dials', () =>
	withReceiverPort(undefined, () => {
		assert.equal(receiverPort(), 8126);
	}));

test('receiverPort() honours DD_APM_RECEIVER_PORT', () =>
	withReceiverPort('9126', () => {
		assert.equal(receiverPort(), 9126);
	}));

test('an unusable DD_APM_RECEIVER_PORT falls back to 8126, and says so', async () => {
	// The fallback itself is right: 8126 is what dd-trace dials. Taking it in
	// silence is not, because the agent reads the same variable and resolves it
	// differently, so the launcher ends up probing a port nothing will bind.
	for (const bad of ['banana', '-1', '70000', '0abc']) {
		const warnings = await captureWarnings(() =>
			withReceiverPort(bad, () => {
				assert.equal(receiverPort(), 8126, `override "${bad}"`);
			})
		);
		assert.equal(warnings.length, 1, `override "${bad}" was rewritten with no warning`);
		assert.ok(warnings[0].includes(bad), `the warning must quote the rejected value; got: ${warnings[0]}`);
	}
});

test('DD_APM_RECEIVER_PORT=0 is a configuration, not a typo', async () => {
	// Upstream reads 0 as "serve no HTTP receiver" (the UDS-only setup). Folding it
	// into the 8126 fallback is what produces the alive-but-not-bound case: the
	// launcher probes 8126, the agent binds nothing, every signal says started.
	const warnings = await captureWarnings(() =>
		withReceiverPort('0', () => {
			assert.equal(receiverPort(), 0);
		})
	);
	assert.deepEqual(warnings, [], 'an explicit 0 must not be reported as a bad value');
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
});

test('isTraceReceiverHealthy() is false when nothing listens', async () => {
	assert.equal(await isTraceReceiverHealthy(await findFreePort()), false);
});

test('a /info listing a /traces endpoint is the only healthy answer', () =>
	withReceiver({ body: { endpoints: ['/v0.4/traces', '/v0.7/config'] } }, async (port) => {
		assert.equal(await isTraceReceiverHealthy(port), true);
	}));

test('the probe asks /info specifically, not just any answering path', () =>
	// A receiver serving the right body somewhere else must read as unhealthy,
	// or a probe-URL typo in the launcher would ship green against this suite.
	withReceiver({ body: { endpoints: ['/v0.4/traces'] }, path: '/some-other-info' }, async (port) => {
		assert.equal(await isTraceReceiverHealthy(port), false);
	}));

test('an HTTP listener without a /traces endpoint is not a receiver', async () => {
	// Any leftover health-check stub accepts connections and answers 200;
	// treating it as "APM is handled" is the failure this probe exists to stop.
	for (const body of [{ endpoints: ['/health'] }, { endpoints: [] }, {}, { endpoints: 'not-an-array' }]) {
		await withReceiver({ body }, async (port) => {
			assert.equal(await isTraceReceiverHealthy(port), false, `body ${JSON.stringify(body)} passed for a trace-agent`);
		});
	}
});

test('a non-2xx or non-JSON /info answer is unhealthy, not an error', async () => {
	for (const options of [{ status: 503, body: { endpoints: ['/v0.4/traces'] } }, { raw: '<html>It works!</html>' }]) {
		await withReceiver(options, async (port) => {
			assert.equal(await isTraceReceiverHealthy(port), false);
		});
	}
});

test('a listener that accepts and never answers times out to unhealthy', async () => {
	// A bare TCP socket is exactly what a stray port-forward looks like. The
	// accepted sockets are destroyed by hand: the aborted probe can leave its
	// server side open, and net.Server.close() waits on it forever.
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await withServer(server, async (port) => {
		try {
			assert.equal(await isTraceReceiverHealthy(port, 250), false);
		} finally {
			for (const socket of sockets) socket.destroy();
		}
	});
});

test('onExit() treats a signal as a clean stop', async () => {
	assert.equal(await exitCodeFrom(() => onExit('core', 'datadog-agent', null, 'SIGTERM')), 0);
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
