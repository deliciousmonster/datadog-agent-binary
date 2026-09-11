// The verdict this run reported for twelve hours, `traces-unconfirmed`, said the trace hop was unknown
// while it was provable. trace_writer publishes zeros on 7.82.1 even while the writer delivers, and a
// stock datadog/agent:7.82.1 container reproduces that with traces accepted and no send failures, so the
// counter is not evidence. The writer's own failure lines are, and on the 2026-09-08 run every one of
// them fell inside a wrong-key window while eight hours of steady state produced none.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { deliveryVerdict, readTraceHop } from "../../runtime/component.js";

const stamp = (msAgo) =>
	new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");

const REFUSALS = [
	'| TRACE | WARN | (pkg/trace/writer/sender.go:362 in sendOnce) | Retried payload 4 times: server responded with "403 Forbidden"',
	"| TRACE | WARN | (pkg/trace/log/throttled.go:46 in log) | Trace Payload dropped (4.34KB).",
	"| TRACE | ERROR | (pkg/trace/log/throttled.go:46 in log) | Received unexpected status code 403",
];
const NOISE =
	"| TRACE | INFO | (comp/core/agenttelemetry/impl/agenttelemetry.go:128 in Run) | Starting agent telemetry run";

/** The shape deliveryVerdict reads: spans arriving, stats accepted, trace_writer dead as it is on 7.82.1. */
const flowing = {
	receiver: [
		{
			Lang: "nodejs",
			TracerVersion: "6.15.0",
			TracesReceived: 1282,
			SpansReceived: 2563,
		},
	],
	stats_writer: {
		Payloads: 3,
		StatsBuckets: 3,
		ClientPayloads: 3,
		Errors: 0,
		Retries: 0,
	},
	trace_writer: {
		Payloads: 0,
		Bytes: 0,
		Traces: 0,
		Spans: 0,
		Errors: 0,
		Retries: 0,
	},
};

describe("the trace hop", () => {
	let dir;
	let log;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "dd-trace-hop-"));
		log = join(dir, "trace-agent.log");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	describe("readTraceHop", () => {
		it("finds a refusal inside the window", () => {
			writeFileSync(log, `${stamp(30_000)} UTC ${REFUSALS[0]}\n`);
			const hop = readTraceHop(log, 120_000);
			assert.deepEqual(hop, { refused: true, lines: 1 });
		});

		it("counts every shape the writer uses to say a payload was turned away", () => {
			writeFileSync(
				log,
				REFUSALS.map((line) => `${stamp(10_000)} UTC ${line}`).join("\n")
			);
			assert.equal(readTraceHop(log, 120_000).lines, 3);
		});

		it("NEGATIVE: ignores a refusal older than the window, which is what a chaos round leaves behind", () => {
			writeFileSync(
				log,
				`${stamp(20 * 60_000)} UTC ${REFUSALS[1]}\n${stamp(5_000)} UTC ${NOISE}\n`
			);
			assert.deepEqual(readTraceHop(log, 120_000), {
				refused: false,
				lines: 0,
			});
		});

		it("NEGATIVE: reads no refusal out of ordinary traffic", () => {
			writeFileSync(
				log,
				`${stamp(5_000)} UTC ${NOISE}\n${stamp(1_000)} UTC ${NOISE}\n`
			);
			assert.equal(readTraceHop(log, 120_000).refused, false);
		});

		it("answers null for a log it cannot read, so the caller falls back rather than guesses", () => {
			assert.equal(readTraceHop(join(dir, "absent.log"), 120_000), null);
			assert.equal(readTraceHop(undefined), null);
		});
	});

	describe("the verdict", () => {
		it("reads traces-unrefuted when spans arrive, stats land, and nothing was turned away", () => {
			const signal = deliveryVerdict(flowing, "test", {
				refused: false,
				lines: 0,
			});
			assert.equal(signal.verdict, "traces-unrefuted");
			assert.match(signal.detail, /no refusal/);
			assert.match(signal.detail, /trace_writer is not evidence/);
		});

		it("reads rejected when the writer logged a refusal, even with stats landing", () => {
			const signal = deliveryVerdict(flowing, "test", {
				refused: true,
				lines: 4,
			});
			assert.equal(signal.verdict, "rejected");
			assert.match(signal.detail, /4 refusal/);
			assert.equal(signal.proven.tracesAtDatadog, false);
		});

		it("NEGATIVE: without a log it stays traces-unconfirmed, and says that is why", () => {
			const signal = deliveryVerdict(flowing, "test", null);
			assert.equal(signal.verdict, "traces-unconfirmed");
			assert.match(signal.detail, /No trace-agent log was given/);
		});

		it("NEGATIVE: a quiet node is still idle, not unrefuted", () => {
			const quiet = {
				receiver: [],
				stats_writer: {
					Payloads: 0,
					StatsBuckets: 0,
					ClientPayloads: 0,
					Errors: 0,
					Retries: 0,
				},
				trace_writer: { Payloads: 0, Errors: 0, Retries: 0 },
			};
			assert.equal(
				deliveryVerdict(quiet, "test", { refused: false, lines: 0 }).verdict,
				"idle"
			);
		});

		it("keeps delivering when the writer does report a payload, since that is proof and this is not", () => {
			const proving = {
				...flowing,
				trace_writer: { ...flowing.trace_writer, Payloads: 2, Bytes: 4096 },
			};
			assert.equal(
				deliveryVerdict(proving, "test", { refused: false, lines: 0 }).verdict,
				"delivering"
			);
		});
	});
});
