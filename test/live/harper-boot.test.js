// Proof, not a call-shape check: a real Harper node, real spans posted to its real receiver, a real
// authenticated GET reading back what it counted. Every DIMENSIONS row runs the same body.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DIMENSIONS,
	bootHarper,
	driveTraffic,
	readDelivery,
} from "./harness.js";

const SPAN_COUNT = 5;
const DELIVERY_DEADLINE_MS = 60_000;

for (const row of DIMENSIONS) {
	test(`${row.name}: real spans sent land in the real receiver and are read back over real HTTP`, async () => {
		const handle = await bootHarper(row);
		try {
			await driveTraffic(handle, SPAN_COUNT);

			// The trace-agent's stats window is a periodic bucket, not an on-write counter, so a fresh
			// burst can sit at the right receiver count with a stale "idle" verdict for several seconds.
			const deadline = Date.now() + DELIVERY_DEADLINE_MS;
			let status;
			while (Date.now() < deadline) {
				status = await readDelivery(handle).catch(() => status);
				if (
					status?.delivery?.receiver.tracesReceived === SPAN_COUNT &&
					status.delivery.verdict !== "idle"
				) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			assert.ok(
				status,
				`DatadogStatus at ${handle.statusUrl} never answered within ${DELIVERY_DEADLINE_MS}ms`
			);

			assert.equal(
				status.delivery.receiver.tracesReceived,
				SPAN_COUNT,
				`the real trace-agent receiver reported ${status.delivery.receiver.tracesReceived} traces, not the ${SPAN_COUNT} this run actually sent: ${JSON.stringify(status.delivery)}`
			);
			assert.notEqual(
				status.delivery.verdict,
				"idle",
				`the delivery verdict never left "idle" within ${DELIVERY_DEADLINE_MS}ms of sending real traffic: ${JSON.stringify(status.delivery)}`
			);
		} finally {
			await handle.stop();
		}
	});
}
