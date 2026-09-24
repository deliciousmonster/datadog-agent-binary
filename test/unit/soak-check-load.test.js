// Whether a failure was the node breaking or the box being starved. This machine is shared, and two legs
// have been lost to unrelated work on it: the test gate once, somebody's rustc build at 900% CPU the
// next time. Both times the data said only "requests failed", and the only way to tell the difference was
// catching `ps` live while it happened. The load is recorded per row now, and named in the verdict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLeg } from "../soak/soak-check.mjs";

const COLS = [
	"ts",
	"up",
	"cpu",
	"mem",
	"req/s",
	"fail",
	"load",
	"sup",
	"verified",
	"chaos",
];

/** A leg whose rows all fail outside chaos, at the given load. */
function legAtLoad(load, { withLoadColumn = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "soak-check-load-"));
	const cols = withLoadColumn ? COLS : COLS.filter((c) => c !== "load");
	const rows = [cols.join("\t")];
	for (let i = 0; i < 40; i++) {
		const r = {
			ts: `2026-09-24 15:${String(i).padStart(2, "0")}:00`,
			up: (i / 60).toFixed(2) + "h",
			cpu: "20%",
			mem: "1.000GiB",
			"req/s": "19.5",
			fail: "40",
			load: String(load),
			sup: "guard",
			verified: "TT",
			chaos: "none",
		};
		rows.push(cols.map((c) => r[c]).join("\t"));
	}
	writeFileSync(join(dir, "status.tsv"), rows.join("\n") + "\n");
	return dir;
}

const failureText = (r) =>
	r.failures.find((f) => f.includes("requests failed")) ?? "";

test("failures on a quiet box are reported without excusing them, and without blaming load", () => {
	const result = checkLeg(legAtLoad(1.5));
	assert.match(failureText(result), /requests failed with no chaos in flight/);
	assert.match(failureText(result), /load on those rows: 1\.5 to 1\.5/);
	assert.doesNotMatch(failureText(result), /starvation/);
});

// The verdict stays a failure. Excusing a row on load would be a way to hide a real defect; the point is
// that the reason is in the output rather than needing to be caught live.
test("failures on a loaded box are still failures, but the verdict says starvation is the likelier cause", () => {
	const result = checkLeg(legAtLoad(21.5));
	assert.equal(result.pass, false, "load must not excuse a failure");
	assert.match(failureText(result), /starvation than a defect/);
	assert.match(failureText(result), /21\.5/);
});

test("a run recorded before the load column existed still reads, with no load claim attached", () => {
	const result = checkLeg(legAtLoad(0, { withLoadColumn: false }));
	assert.match(failureText(result), /requests failed with no chaos in flight/);
	assert.doesNotMatch(failureText(result), /load on those rows/);
});
