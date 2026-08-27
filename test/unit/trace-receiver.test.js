/**
 * The receiver facts both callers depend on: `resolveReceiverPort()`,
 * `receiverAdvertisesTraces()`, `waitForReceiver()` and the diagnosis the two
 * verdicts print. Each guards a failure mode that surfaces only as silently
 * dropped spans, and each was written twice before this module existed, which
 * is how the two copies came to disagree.
 *
 * Hermetic: the only sockets are ephemeral 127.0.0.1 listeners standing in for
 * a receiver, the same device test/e2e/harper-component.test.js uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { findFreePort } from '../support/find-free-port.js';
import {
	captureWarnings,
	createReceiverStub,
	importDist,
	withEnv,
	withReceiver,
	withReceiverPort,
	withServer,
} from '../support/harness.js';

const {
	RECEIVER_DISABLED_WARNING,
	describeUnboundReceiver,
	receiverAdvertisesTraces,
	resolveReceiverPort,
	waitForReceiver,
} = await importDist('trace-receiver.js');

test('resolveReceiverPort() defaults to 8126, the port dd-trace dials', () =>
	withReceiverPort(undefined, () => {
		assert.deepEqual(resolveReceiverPort(), { port: 8126 });
	}));

test('resolveReceiverPort() honours DD_APM_RECEIVER_PORT', () =>
	withReceiverPort('9126', () => {
		assert.deepEqual(resolveReceiverPort(), { port: 9126 });
	}));

test('an unusable DD_APM_RECEIVER_PORT falls back to 8126, and says so', () => {
	// The fallback itself is right: 8126 is what dd-trace dials. Taking it in
	// silence is not, because the agent reads the same variable and resolves it
	// differently, so the caller ends up probing a port nothing will bind.
	for (const bad of ['banana', '-1', '70000', '0abc']) {
		withReceiverPort(bad, () => {
			const { port, warning } = resolveReceiverPort();
			assert.equal(port, 8126, `override "${bad}"`);
			assert.ok(warning?.includes(bad), `the warning must quote the rejected value; got: ${warning}`);
		});
	}
});

test('NEGATIVE: resolving a port prints nothing', async () => {
	// The supervisor runs inside Harper, where this package's console never
	// reaches hdb.log. A resolver that logged for itself would put the warning
	// somewhere the operator does not read, which is the same as no warning.
	const warnings = await captureWarnings(() => withReceiverPort('banana', () => resolveReceiverPort()));
	assert.deepEqual(warnings, [], 'the caller decides where the warning lands');
});

test('DD_APM_RECEIVER_PORT=0 is a configuration, not a typo', () =>
	// Upstream reads 0 as "serve no HTTP receiver" (the UDS-only setup). Folding
	// it into the 8126 fallback is what produces the alive-but-not-bound case:
	// the caller probes 8126, the agent binds nothing, every signal says started.
	withReceiverPort('0', () => {
		assert.deepEqual(resolveReceiverPort(), { port: 0 }, 'an explicit 0 must not be reported as a bad value');
	}));

test('receiverAdvertisesTraces() is false when nothing listens', async () => {
	assert.equal(await receiverAdvertisesTraces(await findFreePort()), false);
});

test('a /info listing a /traces endpoint is the only answer that passes', () =>
	withReceiver({ body: { endpoints: ['/v0.4/traces', '/v0.7/config'] } }, async (port) => {
		assert.equal(await receiverAdvertisesTraces(port), true);
	}));

test('the probe asks /info specifically, not just any answering path', () =>
	// A receiver serving the right body somewhere else must read as absent, or a
	// probe-URL typo in a caller would ship green against this suite.
	withReceiver({ body: { endpoints: ['/v0.4/traces'] }, answers: '/some-other-info' }, async (port) => {
		assert.equal(await receiverAdvertisesTraces(port), false);
	}));

test('an HTTP listener without a /traces endpoint is not a receiver', async () => {
	// Any leftover health-check stub accepts connections and answers 200;
	// treating it as "APM is handled" is the failure this probe exists to stop.
	for (const body of [{ endpoints: ['/health'] }, { endpoints: [] }, {}, { endpoints: 'not-an-array' }]) {
		await withReceiver({ body }, async (port) => {
			assert.equal(
				await receiverAdvertisesTraces(port),
				false,
				`body ${JSON.stringify(body)} passed for a trace-agent`
			);
		});
	}
});

test('a non-2xx or non-JSON /info answer reads as absent, not as an error', async () => {
	for (const options of [{ status: 503, body: { endpoints: ['/v0.4/traces'] } }, { raw: '<html>It works!</html>' }]) {
		await withReceiver(options, async (port) => {
			assert.equal(await receiverAdvertisesTraces(port), false);
		});
	}
});

test('a listener that accepts and never answers times out to absent', async () => {
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
			assert.equal(await receiverAdvertisesTraces(port, 250), false);
		} finally {
			for (const socket of sockets) socket.destroy();
		}
	});
});

test('waitForReceiver() gives up on a port nothing binds', async () => {
	assert.equal(await waitForReceiver(await findFreePort(), { timeoutMs: 500 }), false);
});

test('waitForReceiver() is not satisfied by a listener that is not a receiver', () =>
	// A stray port-forward or a health-check stub answers; neither takes a span.
	withReceiver({ body: { endpoints: ['/health'] } }, async (port) => {
		assert.equal(await waitForReceiver(port, { timeoutMs: 500 }), false);
	}));

test('waitForReceiver() keeps polling while the agent is still coming up', async () => {
	// A single probe at spawn time finds nothing and would call a cold start a
	// failure, which is the one way this check could refuse a working launch.
	const port = await findFreePort();
	const server = createReceiverStub({ body: { endpoints: ['/v0.4/traces'] } });
	const late = setTimeout(() => server.listen(port, '127.0.0.1'), 600);
	try {
		assert.equal(await waitForReceiver(port, { timeoutMs: 10000 }), true);
	} finally {
		clearTimeout(late);
		await new Promise((resolve) => server.close(resolve));
	}
});

test('waitForReceiver() stops early when the agent it was watching is gone', async () => {
	// A caller that outlives its agent passes the agent's liveness. Without it the
	// supervisor sits out the full 30s reporting nothing, long after the exit
	// handler said what happened.
	const port = await findFreePort();
	let alive = true;
	setTimeout(() => (alive = false), 300);
	const started = Date.now();
	assert.equal(await waitForReceiver(port, { timeoutMs: 30_000, giveUp: () => !alive }), false);
	assert.ok(Date.now() - started < 5000, 'the deadline was waited out instead of the agent being watched');
});

test('NEGATIVE: a live receiver outranks the reason to give up', () =>
	// An agent that binds and then dies between polls has still proved the port is
	// served, and calling that absent would be a false alarm on a working node.
	withReceiver({ body: { endpoints: ['/v0.4/traces'] } }, async (port) => {
		assert.equal(await waitForReceiver(port, { timeoutMs: 500, giveUp: () => true }), true);
	}));

test('the unbound diagnosis keeps every part an operator acts on', () => {
	const message = describeUnboundReceiver({
		subject: 'datadog-trace-agent',
		pid: 4242,
		port: 8126,
		configPath: '/srv/datadog/datadog.yaml',
		logPath: '/srv/datadog/logs/trace-agent.log',
	});
	// Each of these was in both hand-written copies, and each is a step someone
	// takes next. A shortened message reads as complete and strands them at
	// "not bound", which is the one thing they already know.
	for (const required of [
		'datadog-trace-agent',
		'4242',
		'127.0.0.1:8126',
		'30s',
		'successful flush',
		'apm_config.enabled in /srv/datadog/datadog.yaml',
		'DD_APM_ENABLED',
		'/srv/datadog/logs/trace-agent.log',
	]) {
		assert.ok(message.includes(required), `the diagnosis dropped "${required}": ${message}`);
	}
});

test('DD_APM_ENABLED is quoted as it is, because it overrides the config file', () =>
	// The one override that silently beats apm_config.enabled. Someone reading only
	// the config file finds nothing wrong with it.
	withEnv('DD_APM_ENABLED', 'false', () => {
		const message = describeUnboundReceiver({
			subject: 'the trace-agent',
			port: 8126,
			configPath: '/etc/datadog.yaml',
		});
		assert.match(message, /DD_APM_ENABLED=false/);
		assert.match(message, /the agent's own log/, 'with no log path named, still say to read the agent log');
	}));

test('the disabled-receiver warning names the port dd-trace dials and the way out', () => {
	// receiver_port 0 is a choice, so both callers warn rather than fail. What the
	// warning has to carry is that dd-trace's default target is now unserved.
	assert.match(RECEIVER_DISABLED_WARNING, /127\.0\.0\.1:8126/);
	assert.match(RECEIVER_DISABLED_WARNING, /Unix socket/);
	// Both spellings, because one caller reaches this through the environment and
	// the other writes the config key the variable overrides.
	assert.match(RECEIVER_DISABLED_WARNING, /apm_config\.receiver_port/);
	assert.match(RECEIVER_DISABLED_WARNING, /DD_APM_RECEIVER_PORT/);
});
