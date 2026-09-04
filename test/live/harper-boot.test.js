// Proof, not a call-shape check: a real Harper node, real spans posted to its real receiver, a real
// authenticated GET reading back what it counted. Every DIMENSIONS row runs the same body.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DIMENSIONS,
	bootHarper,
	driveTraffic,
	waitForDelivery,
} from "./harness.js";

const SPAN_COUNT = 5;
const DELIVERY_DEADLINE_MS = 60_000;

// Filled in by each row's own test below, so the cross-row equivalence test can compare real
// delivered counts without booting Harper a second time. A row whose own test failed below leaves
// no entry here, which the comparison test below treats as its own failure rather than skipping it.
const deliveredByRow = new Map();

for (const row of DIMENSIONS) {
	test(`${row.name}: real spans sent land in the real receiver and are read back over real HTTP`, async () => {
		const handle = await bootHarper(row);
		try {
			await driveTraffic(handle, SPAN_COUNT);

			const status = await waitForDelivery(
				handle,
				SPAN_COUNT,
				DELIVERY_DEADLINE_MS
			);
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

			// A row that boots the intended Harper line but silently still falls back to the bundled
			// guard would land the same trace count and look identical from the outside; this is what
			// tells the two paths apart. resources.js reports which supervisor actually answered.
			assert.equal(
				status.supervision,
				row.expectedSupervision,
				`${row.name} ran through "${status.supervision}" supervision, not the expected "${row.expectedSupervision}"`
			);

			deliveredByRow.set(row.name, status.delivery.receiver.tracesReceived);
		} finally {
			await handle.stop();
		}
	});
}

// MOD-10 / MOD-16's acceptance bullet, literally: N requests against each supervision path must
// land N traces on both, not merely two separately-passing tests that happen to agree by eye.
test("MOD-10/MOD-16: every supervision path delivers the same trace count for the same request count", () => {
	const counts = DIMENSIONS.map((row) => {
		assert.ok(
			deliveredByRow.has(row.name),
			`"${row.name}" reported no delivered count; its own boot test above must pass before this comparison means anything`
		);
		return deliveredByRow.get(row.name);
	});

	assert.ok(
		counts.every((count) => count === counts[0]),
		`the same ${SPAN_COUNT} requests produced different trace counts across supervision paths: ${JSON.stringify(
			Object.fromEntries(
				DIMENSIONS.map((row, index) => [row.name, counts[index]])
			)
		)}`
	);
});
