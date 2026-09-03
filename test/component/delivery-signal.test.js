// The counters are read asymmetrically and the suite is built around that. `trace_writer` reads zero on a
// healthy node, because two writers register into the one expvar slot and the last reporter goroutine to start
// owns it, so every case below states whether a zero is allowed to reach a verdict.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deliveryVerdict } from "../../runtime/delivery.js";
import { loadComponent } from "../support/component.js";
import { createStub, findFreePort, withServer } from "../support/loopback.js";
import { withEnvs, withTempDir } from "../support/sandbox.js";

// The verdict is a pure read of expvar and is taken from the module that computes it; the two below carry
// this instance's ports, which is what the last test in this file is about.
const { readDeliverySignal, DatadogStatus } = await loadComponent();

// `receiver` is an array upstream, one entry per language and tracer version reaching this agent, so it is one
// here too: a node running two runtimes reports two, and reading only the first under-counts every hop.
const snapshot = ({ receiver = [], stats = {}, traces = {} } = {}) => ({
	version: { Version: "7.75.5" },
	receiver: receiver.map((entry) => ({
		Lang: "nodejs",
		TracerVersion: "5.69.0",
		TracesReceived: 0,
		SpansReceived: 0,
		...entry,
	})),
	stats_writer: {
		Payloads: 0,
		Errors: 0,
		Retries: 0,
		StatsBuckets: 0,
		ClientPayloads: 0,
		...stats,
	},
	trace_writer: { Payloads: 0, Bytes: 0, Errors: 0, Retries: 0, ...traces },
});

const busy = [{ TracesReceived: 1565, SpansReceived: 2677 }];
/** What the concentrator leaves behind for spans it bucketed this minute, whether or not anything was sent. */
const workedThisMinute = { StatsBuckets: 6, ClientPayloads: 2 };

const verdictOf = (vars) => deliveryVerdict(vars, "test").verdict;

test("a trace payload on the wire is the only thing that reads as delivering", () => {
	const signal = deliveryVerdict(
		snapshot({
			receiver: busy,
			stats: { ...workedThisMinute, Payloads: 5 },
			traces: { Payloads: 4, Bytes: 90_112 },
		}),
		"test"
	);
	assert.equal(signal.verdict, "delivering");
	assert.equal(signal.proven.tracesAtDatadog, true);
	assert.match(signal.detail, /4 trace payload\(s\), 90112 bytes/);
});

test("NEGATIVE: traffic flowing with trace_writer at zero is traces-unconfirmed, and the traces hop stays unproven rather than failed", () => {
	// The measured shape on the shipped binary: spans flowing, stats accepted, all nine trace_writer fields zero.
	const signal = deliveryVerdict(
		snapshot({
			receiver: busy,
			stats: { ...workedThisMinute, Payloads: 5 },
		}),
		"test"
	);
	assert.equal(signal.verdict, "traces-unconfirmed");
	assert.deepEqual(signal.proven, {
		tracesAtReceiver: true,
		statsAtDatadog: true,
		tracesAtDatadog: null,
	});
	// A zero read as evidence would land here as `false`, and the endpoint would report a failure that a
	// healthy node produces on every read.
	assert.notEqual(
		signal.proven.tracesAtDatadog,
		false,
		"a zero trace_writer was read as evidence the traces hop is broken"
	);
});

test("NEGATIVE: a deliberately wrong DD_API_KEY reads as rejected on the stats hop, not as delivering", () => {
	// Verified live with a wrong key: the receiver counters climb, stats_writer.Retries climbs, Payloads stays
	// at zero, and trace_writer stays zero throughout because it is not the writer publishing the slot.
	const signal = deliveryVerdict(
		snapshot({
			receiver: busy,
			stats: { ...workedThisMinute, Retries: 6, Errors: 2 },
		}),
		"test"
	);
	assert.equal(signal.verdict, "rejected");
	assert.match(signal.detail, /APM stats payload/);
	assert.equal(signal.proven.statsAtDatadog, false);
	assert.equal(signal.proven.tracesAtDatadog, null);
});

test("NEGATIVE: a refused trace payload names the traces hop, and outranks an accepted stats payload", () => {
	const signal = deliveryVerdict(
		snapshot({
			receiver: busy,
			stats: { ...workedThisMinute, Payloads: 5 },
			traces: { Retries: 3, Errors: 1 },
		}),
		"test"
	);
	assert.equal(signal.verdict, "rejected");
	assert.match(signal.detail, /trace payload/);
	assert.equal(signal.proven.tracesAtDatadog, false);
});

test("NEGATIVE: a node that has gone quiet reads idle off a stale receiver snapshot, never not-delivering", () => {
	// Upstream refreshes the receiver snapshot only when a payload arrives, so this is the last busy minute
	// beside a stats window that has correctly reset. Read together they say "arriving and none accepted".
	const signal = deliveryVerdict(snapshot({ receiver: busy }), "test");
	assert.equal(signal.verdict, "idle");
	assert.match(signal.detail, /left over from an earlier minute/);
});

test("spans bucketed in the same minute with neither hop accepting is what not-delivering means", () => {
	// The one thing that separates this from the case above: the concentrator bucketed spans this minute,
	// so the receiver reading is current rather than left over.
	assert.equal(
		verdictOf(snapshot({ receiver: busy, stats: workedThisMinute })),
		"not-delivering"
	);
	assert.equal(
		verdictOf(snapshot({ receiver: busy })),
		"idle",
		"the stats window is what dates the receiver reading; without it every quiet node reads as broken"
	);
});

test("an agent no tracer has ever reached reads idle with no hop proven", () => {
	const signal = deliveryVerdict(snapshot(), "test");
	assert.equal(signal.verdict, "idle");
	assert.deepEqual(signal.proven, {
		tracesAtReceiver: null,
		statsAtDatadog: null,
		tracesAtDatadog: null,
	});
});

test("the three hops are reported apart, each with the counters its verdict was read from, summed over every client", () => {
	// Upstream publishes one receiver entry per language and tracer version. A node running a second runtime
	// beside Harper's own is the ordinary case, and reading one entry silently under-counts the receiver hop.
	const signal = deliveryVerdict(
		snapshot({
			receiver: [
				...busy,
				{
					Lang: "python",
					TracerVersion: "2.9.1",
					TracesReceived: 35,
					SpansReceived: 123,
				},
			],
			stats: { ...workedThisMinute, Payloads: 5 },
		}),
		"test"
	);
	assert.equal(signal.signalVersion, 1);
	assert.equal(signal.agentVersion, "7.75.5");
	assert.deepEqual(signal.receiver, {
		tracesReceived: 1600,
		spansReceived: 2800,
		clients: ["nodejs 5.69.0", "python 2.9.1"],
	});
	assert.deepEqual(signal.statsWriter, {
		payloads: 5,
		errors: 0,
		retries: 0,
		buckets: 6,
		clientPayloads: 2,
	});
	assert.deepEqual(signal.traceWriter, {
		payloads: 0,
		bytes: 0,
		errors: 0,
		retries: 0,
	});
});

test("counters missing from the payload are read as zero, not as NaN in a verdict", () => {
	// An agent build that drops a field, or a body from something that is not a trace-agent at all.
	const signal = deliveryVerdict({ receiver: "not-an-array" }, "test");
	assert.equal(signal.verdict, "idle");
	assert.equal(signal.statsWriter.payloads, 0);
	assert.equal(signal.traceWriter.payloads, 0);
	assert.deepEqual(signal.receiver.clients, []);
});

test("NEGATIVE: /DatadogStatus/ carries the delivery signal on a thread that started nothing", async () => {
	// The counters belong to the node's trace-agent, so a thread that never ran startup still has a reading to
	// report; a verdict computed and then not wired into the response is the whole ticket going missing.
	const status = await DatadogStatus.get();
	assert.equal(status.delivery.signalVersion, 1);
	assert.ok(
		status.delivery.verdict,
		`the endpoint answered without a delivery verdict: ${JSON.stringify(status.delivery)}`
	);
	// The shell form, because reading the signal through an endpoint inside the traced pipeline perturbs it.
	assert.match(status.verify.delivery, /^curl -sk https:\/\/127\.0\.0\.1:\d+/);
});

test("NEGATIVE: the debug endpoint is read over TLS, so a plaintext answer on that port is no answer at all", async () => {
	// The trace-agent serves expvar under its own self-signed IPC certificate. A plain-http read would take
	// this stub's body and report a verdict off it, which is the whole mutation this asserts against.
	const stub = createStub({
		answers: "/debug/vars",
		body: snapshot({ receiver: busy, stats: { Payloads: 5 } }),
	});
	const signal = await withServer(stub, (port) => readDeliverySignal(port));
	assert.equal(signal.verdict, "unavailable");
	assert.match(signal.source, /^https:\/\/127\.0\.0\.1:\d+\/debug\/vars$/);
});

test("NEGATIVE: nothing answering the debug port is unavailable, never a delivery failure", async () => {
	const signal = await readDeliverySignal(await findFreePort());
	assert.equal(signal.verdict, "unavailable");
	assert.equal(signal.signalVersion, 1);
	assert.match(signal.detail, /nothing answered/);
});

test("NEGATIVE: a debug port turned off is unavailable and says which setting turned it off", async () => {
	const signal = await readDeliverySignal(0);
	assert.equal(signal.verdict, "unavailable");
	assert.match(
		signal.detail,
		/apm_config\.debug\.port is 0 \(DD_APM_DEBUG_PORT\)/
	);
});

/** The port a component instance renders into apm_config.debug.port, beside the one its delivery read dials. */
async function debugPorts(env) {
	// Loaded inside the env window, because the module resolves its ports once at import.
	const component = await withEnvs(env, () => loadComponent());
	const rendered = await withTempDir("dd-debug-", (root) =>
		withEnvs({ ROOTPATH: root }, () => {
			const runtime = component.prepareRuntime();
			return runtime.configFiles[runtime.paths.configFile];
		})
	);
	const { source } = await component.readDeliverySignal();
	return {
		rendered,
		configured: rendered.match(
			/^apm_config:$[\s\S]*?^ {2}debug:$\n^ {4}port: (\d+)$/m
		)?.[1],
		source,
	};
}

test("NEGATIVE: the port the agent is told to serve expvar on is the port the signal reads", async () => {
	// Rendered on one port and read on another is silent: every read reports unavailable on a healthy node.
	const byDefault = await debugPorts({ DD_APM_DEBUG_PORT: undefined });
	assert.ok(
		byDefault.configured,
		`the rendered datadog.yaml carries no apm_config.debug.port, so the trace-agent publishes no expvar:\n${byDefault.rendered}`
	);
	assert.equal(
		byDefault.source,
		`https://127.0.0.1:${byDefault.configured}/debug/vars`
	);

	// Moving the port has to move both halves at once, or one of them addresses something nothing serves.
	const moved = await debugPorts({ DD_APM_DEBUG_PORT: "5099" });
	assert.equal(
		moved.configured,
		"5099",
		"DD_APM_DEBUG_PORT does not reach the rendered datadog.yaml, so the agent serves a port the operator did not choose"
	);
	assert.equal(
		moved.source,
		"https://127.0.0.1:5099/debug/vars",
		"DD_APM_DEBUG_PORT does not reach the port the delivery signal dials"
	);
});
