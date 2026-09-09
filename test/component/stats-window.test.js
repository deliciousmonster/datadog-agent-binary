// The soak published `not-delivering` and `idle` on a node with 2,483 spans arriving and nothing wrong. Every
// counter the trace-agent publishes is a window it resets, and measured against 7.82.1 on 2026-09-09 the
// stats_writer window resets every 60 seconds while the writer flushes one payload per 10, so `Payloads` reads
// zero for the first ten seconds of each window. A reader polling on a 60-second period phase-locks into that
// band and reads zero minute after minute until its clock drifts out. What separates a stopped hop from that
// phase is the time since a window did accept something, so the reader keeps it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	STATS_RECALL_MS,
	deliveryVerdict,
	forgetStatsHistory,
	recallStatsWindow,
} from "../../runtime/delivery.js";

const snapshot = ({ stats = {}, spans = 2483 } = {}) => ({
	version: { Version: "7.82.1" },
	receiver: [
		{
			Lang: "nodejs",
			TracerVersion: "6.15.0",
			TracesReceived: Math.round(spans / 2),
			SpansReceived: spans,
		},
	],
	stats_writer: {
		Payloads: 0,
		Bytes: 0,
		Errors: 0,
		Retries: 0,
		StatsBuckets: 0,
		ClientPayloads: 0,
		...stats,
	},
	trace_writer: { Payloads: 0, Bytes: 0, Errors: 0, Retries: 0 },
});

const bucketed = { StatsBuckets: 6, ClientPayloads: 2 };
const clean = { refused: false, lines: 0 };
const ago = (ms) => ({ statsAcceptedMsAgo: ms });

describe("an empty stats window", () => {
	it("reads unrefuted when a window inside the recall did accept, instead of not-delivering", () => {
		const signal = deliveryVerdict(
			snapshot({ stats: bucketed }),
			"test",
			clean,
			ago(47_000)
		);
		assert.equal(signal.verdict, "traces-unrefuted");
		assert.match(signal.detail, /accepted an APM stats payload 47s ago/);
		assert.match(signal.detail, /empty stats window/);
		assert.equal(signal.statsAcceptedMsAgo, 47_000);
	});

	it("reads unconfirmed on the same window with no trace-agent log to rule a refusal out", () => {
		const signal = deliveryVerdict(
			snapshot({ stats: bucketed }),
			"test",
			null,
			ago(12_000)
		);
		assert.equal(signal.verdict, "traces-unconfirmed");
		assert.match(signal.detail, /12s ago/);
	});

	it("covers the phase with no bucket in the window either, which is the same read one flush earlier", () => {
		// StatsBuckets is windowed too, so the concentrator having bucketed nothing yet is not a quiet node.
		// Before this the verdict read `idle` beside 2,483 spans, twice in a row on the 2026-09-09 run.
		const signal = deliveryVerdict(snapshot(), "test", clean, ago(58_000));
		assert.equal(signal.verdict, "traces-unrefuted");
	});

	it("NEGATIVE: falls back to not-delivering once the last acceptance is older than the recall", () => {
		const signal = deliveryVerdict(
			snapshot({ stats: bucketed }),
			"test",
			clean,
			ago(STATS_RECALL_MS + 20_000)
		);
		assert.equal(signal.verdict, "not-delivering");
		assert.match(signal.detail, /200s ago/);
		assert.match(signal.detail, /longer than the 180s/);
	});

	it("NEGATIVE: a refusal in the log outranks the recall, so a vouched node still reads rejected", () => {
		const signal = deliveryVerdict(
			snapshot({ stats: bucketed }),
			"test",
			{ refused: true, lines: 3 },
			ago(5_000)
		);
		assert.equal(signal.verdict, "rejected");
		assert.equal(signal.proven.tracesAtDatadog, false);
	});

	it("NEGATIVE: refused stats counters outrank the recall too", () => {
		const signal = deliveryVerdict(
			snapshot({ stats: { ...bucketed, Retries: 4, Errors: 2 } }),
			"test",
			clean,
			ago(5_000)
		);
		assert.equal(signal.verdict, "rejected");
		assert.match(signal.detail, /APM stats payload/);
	});

	it("NEGATIVE: no recall leaves every verdict exactly where it was", () => {
		assert.equal(
			deliveryVerdict(snapshot({ stats: bucketed }), "test", clean).verdict,
			"not-delivering"
		);
		assert.equal(deliveryVerdict(snapshot(), "test", clean).verdict, "idle");
		assert.equal(
			deliveryVerdict(snapshot({ spans: 0 }), "test", clean, ago(5_000))
				.verdict,
			"idle",
			"a node no tracer reached is idle whatever was accepted a minute ago"
		);
	});

	it("NEGATIVE: does not vouch off a garbage recall", () => {
		for (const bad of [Number.NaN, undefined, null, "soon", -0 / 0]) {
			const signal = deliveryVerdict(
				snapshot({ stats: bucketed }),
				"test",
				clean,
				{
					statsAcceptedMsAgo: bad,
				}
			);
			assert.equal(signal.verdict, "not-delivering", String(bad));
			assert.equal(signal.statsAcceptedMsAgo, undefined);
		}
	});

	it("proves nothing about this window from the recall", () => {
		const signal = deliveryVerdict(
			snapshot({ stats: bucketed }),
			"test",
			clean,
			ago(5_000)
		);
		assert.equal(
			signal.proven.statsAtDatadog,
			null,
			"an acceptance five seconds ago is not this window accepting"
		);
	});
});

describe("what the reader remembers", () => {
	it("answers from the previous read and records this one, never the other way round", () => {
		forgetStatsHistory();
		const src = "https://127.0.0.1:5012/debug/vars";
		assert.equal(
			recallStatsWindow(src, 4, 1_000),
			undefined,
			"the first read has nothing behind it, so it vouches for nothing"
		);
		assert.equal(recallStatsWindow(src, 0, 61_000), 60_000);
		assert.equal(
			recallStatsWindow(src, 0, 121_000),
			120_000,
			"an empty window does not move the mark, so the gap keeps growing"
		);
		assert.equal(recallStatsWindow(src, 7, 181_000), 180_000);
		assert.equal(recallStatsWindow(src, 0, 191_000), 10_000);
	});

	it("NEGATIVE: keeps two ports apart, so one node's second agent vouches for nothing", () => {
		forgetStatsHistory();
		recallStatsWindow("https://127.0.0.1:5012/debug/vars", 4, 1_000);
		assert.equal(
			recallStatsWindow("https://127.0.0.1:5013/debug/vars", 0, 2_000),
			undefined
		);
	});

	it("NEGATIVE: forgets on demand, so a restarted node does not inherit the old one's mark", () => {
		const src = "https://127.0.0.1:5012/debug/vars";
		recallStatsWindow(src, 4, 1_000);
		forgetStatsHistory();
		assert.equal(recallStatsWindow(src, 0, 2_000), undefined);
	});
});
