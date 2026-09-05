// The retry schedule is the other half of what turned one slow bind into hundreds of spans a boot: nine
// worker threads each probing an unbound 127.0.0.1:5000 every 250ms for the six to seven seconds the core
// agent takes to bind is roughly 120 attempts a thread.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { parseJson, pollEndpoint } from "../../runtime/probe.js";
import { createStallingTlsStub, createTlsStub } from "../fixtures/tls-stub.js";
import { createStub, findFreePort, withServer } from "../support/loopback.js";
import { withPatchedSetTimeout } from "../support/sandbox.js";

/** The sleeps pollEndpoint asks for, read off the clock rather than waited out. */
async function recordedWaits(options, stopAfter) {
	const waits = [];
	let armed = false;
	await withPatchedSetTimeout(
		// Nothing awaits between giveUp returning and the backoff's setTimeout, so the first setTimeout
		// after a giveUp is always the backoff and never some other library's timer.
		(realSetTimeout) =>
			(callback, ms, ...rest) => {
				if (!armed) return realSetTimeout(callback, ms, ...rest);
				armed = false;
				waits.push(ms);
				return realSetTimeout(callback, 0, ...rest);
			},
		() =>
			pollEndpoint({
				...options,
				giveUp: () => {
					armed = true;
					return waits.length >= stopAfter;
				},
			})
	);
	return waits;
}

/**
 * 503s the first `failures` probes, then serves. 503 rather than a refused connection: a listener
 * started mid-test races the poll it is meant to outlast.
 */
function failsThenServes(failures) {
	let served = 0;
	return http.createServer((request, response) => {
		const ready = ++served > failures;
		response.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
		response.end(ready ? "expvar" : "not yet");
	});
}

test("NEGATIVE: the poll does not retry at a fixed interval; it doubles and then caps", async () => {
	// Nothing is listening, so every probe fails the way a pre-bind expvar port does.
	const port = await findFreePort();
	const waits = await recordedWaits(
		{ url: `http://127.0.0.1:${port}/debug/vars` },
		8
	);

	// Probes arrive at 0, 250, 750, 1750, 3750, 7750ms: five inside the ~7s bind window where a flat
	// 250ms retry lands about 28, and the sixth already past the 6.8s bind this was measured against.
	assert.deepEqual(
		waits,
		[250, 500, 1000, 2000, 4000, 5000, 5000, 5000],
		"the backoff must double from intervalMs and then cap, or a target that binds late costs one probe every 250ms until it does"
	);
});

test("the deadline still bounds the poll: the last wait is truncated, not overrun", async () => {
	// Deliberately real time, unlike every other test in this file: this is the actual clamp-vs-backoff
	// race, which a mocked setTimeout can't reproduce. The window below is widened for a loaded runner.
	const port = await findFreePort();
	const started = Date.now();
	const body = await pollEndpoint({
		url: `http://127.0.0.1:${port}/debug/vars`,
		timeoutMs: 300,
		intervalMs: 200,
	});
	const elapsed = Date.now() - started;

	assert.equal(body, null, "nothing was listening, so the deadline had to win");
	assert.ok(
		elapsed >= 260,
		`gave up after ${elapsed}ms, short of the 300ms deadline it was given`
	);
	// Unclamped, the second wait doubles to 400ms and the poll lands around 600ms.
	assert.ok(
		elapsed < 550,
		`ran ${elapsed}ms against a 300ms deadline: the backoff is sleeping past it`
	);
});

test("a poll that had to wait reports what it cost, once", async () => {
	const reports = [];
	const body = await withServer(failsThenServes(2), (port) =>
		pollEndpoint({
			url: `http://127.0.0.1:${port}/debug/vars`,
			intervalMs: 20,
			onRetried: (report) => reports.push(report),
		})
	);

	assert.equal(
		body,
		"expvar",
		"the poll must still return the body it waited for"
	);
	assert.equal(
		reports.length,
		1,
		"one report per poll, not one per attempt: the point is a single line per thread"
	);
	assert.equal(
		reports[0].attempts,
		3,
		`two failures then a success is three attempts, got ${reports[0].attempts}`
	);
	assert.ok(
		reports[0].waitedMs >= 50,
		`reported ${reports[0].waitedMs}ms, under the 20ms + 40ms it actually slept`
	);
});

test("NEGATIVE: a throwing onRetried costs neither the body nor the never-throws guarantee", async () => {
	// It fires after a successful probe, so an unguarded call would lose a body already in hand and fail the
	// verify on a healthy node, which is worse than the diagnostic it was added for.
	const body = await withServer(failsThenServes(1), (port) =>
		pollEndpoint({
			url: `http://127.0.0.1:${port}/debug/vars`,
			intervalMs: 20,
			onRetried: () => {
				throw new Error("a logger this component does not control");
			},
		})
	);

	assert.equal(
		body,
		"expvar",
		"the caller lost the body its probe had already fetched"
	);
});

test("NEGATIVE: an endpoint that answers first time reports nothing", async () => {
	// Nine threads a boot: a line on the normal path is noise, and noise is what hid the original defect.
	const reports = [];
	const body = await withServer(
		createStub({ body: { endpoints: ["/v0.4/traces"] } }),
		(port) =>
			pollEndpoint({
				url: `http://127.0.0.1:${port}/info`,
				onRetried: (report) => reports.push(report),
			})
	);

	assert.notEqual(
		body,
		null,
		"the stub answered, so the poll must have a body"
	);
	assert.deepEqual(
		reports,
		[],
		"onRetried fired without a retry, so every thread would log a wait on every boot"
	);
});

test("NEGATIVE: the insecure branch answers null rather than rejecting, same as the fetch branch", async () => {
	// readDeliverySignal's own never-rejects contract rests on this one, and both branches call into a
	// dd-trace private path that can move under either of them.
	const answered = await pollEndpoint({
		// A port outside 1-65535 is not a URL, so node:https throws before it ever opens a socket.
		url: "https://127.0.0.1:99999/debug/vars",
		insecureTls: true,
		giveUp: () => true,
	});
	assert.equal(
		answered,
		null,
		"a request the https client refused outright rejected out of a poll documented never to throw"
	);
});

test("the insecure branch reads a body back off a real TLS endpoint", async () => {
	// The half of probe.js the trace-agent's own expvar is behind. Nothing else in the suite dials TLS, so
	// without this every insecure-branch test could pass against a client that can only ever answer null.
	const body = await withServer(
		createTlsStub({ body: { pid: "4321" } }),
		(port) =>
			pollEndpoint({
				url: `https://127.0.0.1:${port}/debug/vars`,
				insecureTls: true,
				giveUp: () => true,
			})
	);

	assert.equal(
		parseJson(body)?.pid,
		"4321",
		`the insecure branch answered ${body} for a body a plain curl reads back whole`
	);
});

test("NEGATIVE: a TLS response that starts and then stalls settles rather than hanging its caller", async () => {
	// The request-level timeout fires and destroys the socket, but by then the request is long finished: the
	// reset lands on the response, and a listener on the request alone never hears it. readDeliverySignal is
	// on the unconditional path of GET /DatadogStatus/, so an unsettled probe there is an endpoint that
	// never answers and one leaked promise per call.
	const held = [];
	const settled = await withServer(
		createStallingTlsStub(held),
		async (port) => {
			const answered = await Promise.race([
				pollEndpoint({
					url: `https://127.0.0.1:${port}/debug/vars`,
					insecureTls: true,
					timeoutMs: 2000,
					giveUp: () => true,
				}).then(() => "settled"),
				new Promise((resolve) =>
					setTimeout(() => resolve("still pending"), 8000)
				),
			]);
			// Whatever the race said, the held responses have to end here: the server cannot close while one is
			// open, and a poll still waiting on one would keep this test's own teardown from finishing.
			held.forEach((response) => response.end("null}"));
			return answered;
		}
	);

	assert.equal(
		settled,
		"settled",
		"a probe against a stalled response never came back, so every status read after it hangs too"
	);
	assert.equal(
		held.length,
		1,
		"the stub was supposed to be dialled exactly once"
	);
});
