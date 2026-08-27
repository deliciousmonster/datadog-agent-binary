/**
 * The delivery signal `/DatadogStatus/` reports, and the counter it refuses to read.
 *
 * `datadog-agent status` renders `trace_writer` under `Writer (previous minute)`. On the
 * pinned 7.82.1 that field is zero whatever the agent is doing: upstream constructs a
 * `TraceWriter` and a `TraceWriterV1` unconditionally (`pkg/trace/agent/agent.go`), each
 * spawns a `reporter()` whose second statement is `info.UpdateTraceWriterInfo(...)`, and that
 * function assigns a single global pointer (`pkg/trace/info/writer.go`). Last registration
 * wins, and the v1.0 writer receives nothing from a dd-trace that posts to `/v0.4/traces`.
 *
 * That inverts the defect this package exists to fix: a healthy pipeline that reads as broken
 * in exactly the place an operator looks. So the fixtures below are the shapes a real agent
 * produces, and every case asserts the verdict is decided without `trace_writer`. The first
 * one is the deployment's actual reading: `trace_writer` all zero while spans flow and the
 * intake accepts them.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, createDistSandbox, makeTempDir, withEnv } from '../support/harness.js';
import { findFreePort } from '../support/find-free-port.js';

const sandbox = createDistSandbox({ prefix: 'ddab-delivery-' });
fs.copyFileSync(path.join(REPO_ROOT, 'example', 'dd-supervisor.js'), path.join(sandbox, 'dd-supervisor.js'));
const supervisorUrl = pathToFileURL(path.join(sandbox, 'dd-supervisor.js')).href;
const { deliveryVerdict, prepareRuntime, readDeliverySignal, untraceAgentProbes } = await import(supervisorUrl);

/**
 * A module instance that has never seen a delivery. `everDelivered` is a per-thread
 * high-water mark, so it is real state that outlives a call and every case after the first
 * successful one would otherwise inherit it.
 */
async function coldSupervisor() {
	return import(`${supervisorUrl}?cold=${Math.random()}`);
}

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** All nine `trace_writer` fields at zero: what 7.82.1 publishes regardless of traffic. */
const TRACE_WRITER_ZERO = {
	Bytes: 0,
	BytesUncompressed: 0,
	Errors: 0,
	Events: 0,
	Payloads: 0,
	Retries: 0,
	SingleMaxSize: 0,
	Spans: 0,
	Traces: 0,
};

/** One `receiver[]` entry, in the field names upstream publishes (Go names, no json tags). */
function receiverEntry(overrides = {}) {
	return {
		Lang: 'nodejs',
		TracerVersion: '6.12.0',
		TracesReceived: 20,
		SpansReceived: 80,
		PayloadAccepted: 2,
		PayloadRefused: 0,
		PayloadTimeout: 0,
		SpansDropped: 0,
		...overrides,
	};
}

function expvar({ receiver = [receiverEntry()], stats_writer = {}, trace_writer = TRACE_WRITER_ZERO } = {}) {
	return {
		version: { Version: '7.82.1', GitCommit: 'dd7ddd63' },
		uptime: 125,
		receiver,
		trace_writer,
		stats_writer: { Bytes: 0, ClientPayloads: 0, Errors: 0, Payloads: 0, Retries: 0, StatsBuckets: 0, ...stats_writer },
	};
}

test('the deployment reading: trace_writer all zero, and the verdict is still delivering', () => {
	const signal = deliveryVerdict(expvar({ stats_writer: { Payloads: 3, StatsBuckets: 3, Bytes: 2483 } }));
	assert.equal(
		signal.verdict,
		'delivering',
		'this is the exact snapshot the deployed node produced: ten logged flushes, ' +
			'stats_writer accumulating, trace_writer identically zero. Reading trace_writer ' +
			'reports a working pipeline as broken.'
	);
	assert.equal(signal.statsWriter.payloads, 3);
	assert.equal(signal.receiver.spansReceived, 80);
});

test('NEGATIVE: a non-zero trace_writer does not change the verdict either', () => {
	// The counter is not merely unreliable when zero; it is not consulted. A future agent
	// that fixes the race must not silently become the thing this signal depends on, because
	// then the signal only works on the versions that never needed it.
	const busy = { ...TRACE_WRITER_ZERO, Payloads: 99, Traces: 400, Spans: 1600, Bytes: 50000 };
	const withCounter = deliveryVerdict(
		expvar({ trace_writer: busy, stats_writer: { Payloads: 0, Retries: 0, StatsBuckets: 3 } })
	);
	assert.equal(
		withCounter.verdict,
		'not-delivering',
		'trace_writer said 99 payloads and stats_writer said none were accepted. The verdict ' +
			'must follow the counter with one producer, not the one with two.'
	);
	assert.ok(
		!JSON.stringify(withCounter).includes('"traceWriter":'),
		'the report must not carry a traceWriter reading an operator could mistake for a signal'
	);
});

test('a bogus API key reads as rejected, not as delivering', () => {
	// Measured against the shipped 7.82.1 binary with a junk key: the receiver counters
	// climbed, stats_writer.Retries climbed, Payloads stayed at 0, and Errors stayed at 0.
	// Errors is not the tell; Retries is.
	const signal = deliveryVerdict(expvar({ stats_writer: { Payloads: 0, Retries: 6, Errors: 0, ClientPayloads: 2 } }));
	assert.equal(signal.verdict, 'rejected');
	assert.match(signal.detail, /DD_API_KEY/, 'the verdict has to name the thing to go and check');
});

test('a quiet minute on a thread that has never delivered reads as idle, and says what to do', async () => {
	// The receiver array is a per-minute snapshot that upstream empties when nothing arrives,
	// so silence and failure produce the same zeros. Calling that "not delivering" would send
	// an operator to change things that are already right, which is the original defect's
	// failure mode wearing the other hat.
	const cold = await coldSupervisor();
	const signal = cold.deliveryVerdict(expvar({ receiver: [], stats_writer: {} }));
	assert.equal(signal.verdict, 'idle');
	assert.equal(signal.everDelivered, false);
	assert.match(signal.detail, /Work/, 'an idle verdict must say how to turn it into a real answer');
});

test('a quiet minute after a delivery says so, so silence is not read as regression', async () => {
	// Both windows reset every minute. Without the high-water mark, an operator who watched
	// delivery work and then looked again a minute later sees the same zeros a broken node
	// produces, and there is nothing in the payload to tell them apart.
	const cold = await coldSupervisor();
	assert.equal(cold.deliveryVerdict(expvar({ stats_writer: { Payloads: 2 } })).verdict, 'delivering');
	const later = cold.deliveryVerdict(expvar({ receiver: [], stats_writer: {} }));
	assert.equal(later.verdict, 'idle');
	assert.equal(later.everDelivered, true, 'the thread saw delivery succeed; the report has to keep saying so');
});

test('spans arriving with nothing accepted, and the stats writer working, reads as not-delivering', () => {
	const signal = deliveryVerdict(expvar({ stats_writer: { StatsBuckets: 2, ClientPayloads: 1 } }));
	assert.equal(signal.verdict, 'not-delivering');
	assert.equal(signal.receiver.spansReceived, 80);
});

test('NEGATIVE: a stale receiver window on a quiet node is idle, not a delivery failure', async () => {
	// Found by running it. Upstream refreshes the receiver snapshot only when a payload
	// arrives, so a node that has gone quiet keeps publishing its last busy minute while the
	// stats window correctly resets. Read naively that pair says "spans are arriving and none
	// are accepted", which reports a healthy node as broken - the exact mistake the
	// `Writer (previous minute)` field makes and the reason this signal exists.
	//
	// The discriminator is that the stats writer is idle too. The concentrator builds buckets
	// from spans that were received, before anything is sent, so real traffic in the same
	// minute always leaves StatsBuckets or ClientPayloads behind even when delivery fails.
	const cold = await coldSupervisor();
	const signal = cold.deliveryVerdict(expvar({ stats_writer: { Payloads: 0, StatsBuckets: 0, ClientPayloads: 0 } }));
	assert.equal(signal.verdict, 'idle');
	assert.match(signal.detail, /only refreshed when/);
});

test('the report says the window is one minute and not cumulative', () => {
	// Without it the numbers invite a diff, and diffing a counter that resets produces
	// negative deltas an operator reads as data loss.
	const signal = deliveryVerdict(expvar());
	assert.match(signal.window, /minute/);
	assert.match(signal.traceWriterIgnored, /trace_writer/);
});

test('refused and timed-out payloads are surfaced, not summed away', () => {
	const signal = deliveryVerdict(
		expvar({
			receiver: [receiverEntry({ PayloadRefused: 4, PayloadTimeout: 1, SpansDropped: 12 })],
			stats_writer: { Payloads: 1 },
		})
	);
	assert.equal(signal.receiver.payloadRefused, 4);
	assert.equal(signal.receiver.payloadTimeout, 1);
	assert.equal(signal.receiver.spansDropped, 12);
});

test('counters are summed across every reporting tracer, not read off the first', () => {
	// Harper runs one tracer per worker thread, and each registers its own tagset. Reading
	// receiver[0] would report one thread's traffic as the node's.
	const signal = deliveryVerdict(
		expvar({
			receiver: [receiverEntry(), receiverEntry({ TracesReceived: 5, SpansReceived: 20 })],
			stats_writer: { Payloads: 1 },
		})
	);
	assert.equal(signal.receiver.tracesReceived, 25);
	assert.equal(signal.receiver.spansReceived, 100);
	assert.equal(signal.receiver.clients.length, 2);
});

test('a body missing every key it expects produces a verdict rather than a throw', () => {
	// This runs inside a request handler on a database node. A throw here is a 500 on the one
	// endpoint an operator reaches for when something is already wrong.
	for (const body of [{}, { receiver: 'not an array' }, { stats_writer: null }, { receiver: [null, undefined] }]) {
		const signal = deliveryVerdict(body);
		assert.ok(typeof signal.verdict === 'string', `no verdict for ${JSON.stringify(body)}`);
		assert.equal(signal.receiver.spansReceived, 0);
	}
});

test('an endpoint nothing listens on is reported as unavailable, not as a failure to deliver', async () => {
	// "Nothing answered" and "the intake refused everything" send an operator to completely
	// different places, so they must not collapse into one verdict.
	const port = await findFreePort();
	const signal = await readDeliverySignal(port);
	assert.equal(signal.verdict, 'unavailable');
	assert.match(signal.detail, /trace-agent is not running/);
});

test('NEGATIVE: a plain-HTTP server on the debug port is unavailable, not delivering', async () => {
	// The endpoint is HTTPS under the agent's self-signed IPC certificate. A reader that fell
	// back to plain HTTP would accept any process squatting on 5012 as the trace-agent, which
	// is the same mistake as reading a bare TCP connect as a live receiver.
	const server = http.createServer((request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(expvar({ stats_writer: { Payloads: 99 } })));
	});
	const port = await findFreePort();
	await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
	try {
		const signal = await readDeliverySignal(port);
		assert.equal(signal.verdict, 'unavailable');
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('port 0 is reported as the operator turning the endpoint off', async () => {
	const signal = await readDeliverySignal(0);
	assert.equal(signal.verdict, 'unavailable');
	assert.match(signal.detail, /debug\.port is 0/);
});

test('the generated datadog.yaml pins the port the delivery signal reads', () => {
	// The signal probes 5012 because the config says 5012, not because upstream's default
	// happens to be 5012 today. An unpinned port that moves under a future agent turns a
	// working node into "unavailable" on the one endpoint an operator trusts.
	const root = makeTempDir('ddab-delivery-root-');
	try {
		fs.mkdirSync(path.join(root, 'log'), { recursive: true });
		fs.writeFileSync(path.join(root, 'log', 'hdb.log'), '');
		withEnv('ROOTPATH', root, () => {
			const { paths } = prepareRuntime(sandbox);
			const yaml = fs.readFileSync(paths.configFile, 'utf-8');
			assert.match(yaml, /^ {2}debug:$/m, 'apm_config.debug is missing from the generated config');
			assert.match(yaml, /^ {4}port: 5012$/m, 'the expvar port must be written, not assumed');
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/**
 * What `untraceAgentProbes` registered, without a tracer.
 *
 * dd-trace is not a dependency of this package (it is one of the example's), so the matcher
 * cannot be imported here. It does not need to be: string entries in a dd-trace blocklist are
 * compared with `===` against the URI the client plugin builds
 * (`plugins/util/urlfilter.js`, `applyFilter`), so exact membership is the whole contract, and
 * the cases below tie each entry to the URL the supervisor actually polls rather than to a
 * copy of it.
 */
function registeredFilters() {
	const calls = [];
	untraceAgentProbes({ use: (plugin, config) => calls.push({ plugin, config }) });
	return new Map(calls.map((call) => [call.plugin, call.config]));
}

test("NEGATIVE: the supervisor's own probes are excluded from the application's traces", async () => {
	// On the deployed node these were 182 error spans on harper-example, 100% of the
	// service's APM errors, every one 127.0.0.1:8126, while no user request failed.
	// waitForReceiver polls /info every 250ms until the trace-agent binds, so each refusal on
	// the way is an errored client span. A service that reads as unhealthy while working is
	// the failure mode this package exists to remove.
	const registered = registeredFilters();

	// Both, and this is the half that is easy to miss. The receiver probe uses global `fetch`
	// and the expvar read uses node:https, and dd-trace instruments those under two plugin
	// ids: `fetch` is its own plugin extending the http client, so `tracer.use('http', ...)`
	// does not reach it. Registering only `http` leaves the polling probe - the one that
	// produced the errors - fully traced.
	assert.deepEqual([...registered.keys()].sort(), ['fetch', 'http'], 'both client plugins must be configured');

	const blocklist = registered.get('http')?.client?.blocklist;
	assert.ok(
		Array.isArray(blocklist),
		"the http blocklist must sit under `client`. dd-trace's composite plugin hands " +
			'`{...config, ...config.client}` to the client half only, so a top-level blocklist ' +
			'would also reach the server plugin and drop inbound request traces.'
	);
	// `fetch` is the client plugin itself, not a composite, so its config is flat.
	assert.deepEqual(registered.get('fetch')?.blocklist, blocklist, 'the fetch plugin must block the same URIs');
	assert.equal(registered.get('fetch')?.client, undefined, 'the fetch plugin takes a flat config, not a nested one');

	// Taken from the reader itself rather than written out again: if the port or the path
	// moves, the entry has to move with it, and asserting against a literal would not notice.
	const expvarUrl = (await readDeliverySignal(0)).source.replace('127.0.0.1:0', '127.0.0.1:5012');
	assert.ok(blocklist.includes(expvarUrl), `the expvar read (${expvarUrl}) is still traced`);
	assert.ok(
		blocklist.includes('http://127.0.0.1:8126/info'),
		'the receiver probe is still traced. This is the one that polls, and the one that ' +
			'produced every error span on the deployed node.'
	);
});

test('POSITIVE: the blocklist names only the probes, not the application', () => {
	// A blocklist that swallowed the application's own outbound calls would be a worse bug
	// than the one it fixes, and an invisible one. Entries are matched with `===`, so the
	// guard is that there are exactly two of them and both are agent endpoints.
	const blocklist = registeredFilters().get('http').client.blocklist;
	assert.equal(blocklist.length, 2, `expected exactly the two agent probes, got ${JSON.stringify(blocklist)}`);
	for (const entry of blocklist) {
		assert.match(entry, /^https?:\/\/127\.0\.0\.1:\d+\//, `${entry} is not a loopback agent endpoint`);
	}
	// The receiver's own trace intake shares a host and port with the /info probe, so an
	// entry that matched by host would silence dd-trace's own delivery. Exact URIs do not.
	assert.ok(!blocklist.includes('http://127.0.0.1:8126/v0.4/traces'), 'the span intake must never be blocklisted');
});
