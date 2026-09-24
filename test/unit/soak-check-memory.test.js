// The evaluator's memory rule, which decides whether a leg's RSS trend is a leak. It is the rule that
// most nearly threw away a clean matrix: the ratio it replaced compared the first tenth of a run against
// the last, could not tell a cold start from growth, and failed a leg that had plateaued at exactly the
// figure it had settled at on every previous attempt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLeg } from "../soak/soak-check.mjs";

const HEADER = [
	"ts",
	"up",
	"cpu",
	"mem",
	"rss",
	"a",
	"b",
	"req/s",
	"fail",
	"p95",
	"sup",
	"verified",
	"restarts",
	"chaos",
];

/**
 * A leg directory whose RSS follows `mem(hour)`. Everything else is deliberately healthy, so the only
 * thing any verdict can be about is memory.
 *
 * @param {number} hours @param {(h: number) => number} mem
 */
function legWith(hours, mem) {
	const dir = mkdtempSync(join(tmpdir(), "soak-check-mem-"));
	const rows = [HEADER.join("\t")];
	for (let i = 0; i * (1 / 60) <= hours; i++) {
		const h = i / 60;
		const r = [...HEADER].fill("");
		r[0] = `2026-09-24 00:00:${String(i % 60).padStart(2, "0")}`;
		r[1] = `${h.toFixed(2)}h`;
		r[3] = `${mem(h).toFixed(3)}GiB`;
		r[7] = "19.5";
		r[8] = "0";
		r[10] = "guard";
		r[11] = "TT";
		r[13] = "none";
		rows.push(r.join("\t"));
	}
	writeFileSync(join(dir, "status.tsv"), rows.join("\n") + "\n");
	return dir;
}

const memoryFailure = (result) =>
	result.failures.find((f) => f.includes("resident memory"));

test("a flat run passes", () => {
	const result = checkLeg(legWith(12, () => 1.04));
	assert.equal(memoryFailure(result), undefined);
	assert.ok(Math.abs(result.stats.memSlopeMiBPerHour) < 1);
});

// The case this rule exists for. A node that starts cold and climbs to the level it always settles at is
// not leaking, and the ratio that preceded this read exactly that shape as a 1.54x growth.
test("a cold start that climbs to a plateau passes, and the warm-up is what makes it pass", () => {
	const plateau = (h) => (h < 2.2 ? 0.68 + (h / 2.2) * 0.37 : 1.05);
	const result = checkLeg(legWith(12, plateau));
	assert.equal(memoryFailure(result), undefined, JSON.stringify(result.stats));
	// The raw first-tenth-to-last-tenth comparison the old rule made would have been well over its 1.25 bar
	assert.ok(
		1.05 / 0.68 > 1.25,
		"the shape really is the one the old rule failed"
	);
});

test("a sustained climb is still caught", () => {
	const result = checkLeg(legWith(12, (h) => 2.1 + h * 0.0586));
	assert.match(memoryFailure(result) ?? "", /MiB\/hour sustained/);
	assert.ok(result.stats.memSlopeMiBPerHour > 55);
});

// A leak that only starts once the node is warm must not be hidden by excluding the warm-up.
test("a climb that begins after the warm-up window is caught", () => {
	const result = checkLeg(
		legWith(12, (h) => (h < 4 ? 1.0 : 1.0 + (h - 4) * 0.05))
	);
	assert.match(memoryFailure(result) ?? "", /MiB\/hour sustained/);
});

// Short rungs cannot measure a trend, and saying so is better than guessing from fifteen warmed minutes:
// leg 5's healthy one-hour run read +78.9 MiB/hour when a fraction-based warm-up was all that applied.
test("a run too short to have warmed reports that it did not measure, and does not fail", () => {
	const result = checkLeg(legWith(1, (h) => 0.6 + h * 0.4));
	assert.equal(memoryFailure(result), undefined);
	assert.match(result.stats.memTrend ?? "", /not measured/);
	assert.equal(result.stats.memSlopeMiBPerHour, undefined);
});
