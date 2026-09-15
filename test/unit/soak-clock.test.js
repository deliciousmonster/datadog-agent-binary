// The run clock has to survive a restart, and on 2026-09-15 it did not survive one correctly: `stamp()` writes
// UTC with the zone stripped, `Date.parse` read that text as local, and resuming in a UTC-5 zone put the clock
// five hours behind. A 48-hour run would have kept going for 53, and every elapsed reading after a restart was
// wrong by the host's offset. Nothing caught it because the resume path only runs when a 20-hour run restarts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { parseStamp, stamp } from "../../test/soak/soak-clock.mjs";

test("a stamp this harness wrote reads back as the instant it wrote", () => {
	const at = Date.UTC(2026, 8, 14, 22, 27, 36);
	// The exact text the 2026-09-14 run left in its `started` file.
	assert.equal(parseStamp("2026-09-14 22:27:36"), at);
});

// The defect, stated as the thing that must not happen: the zone-less text must not be read as local. A test
// that only asserted "round trips" would pass in UTC and fail nowhere else, so this one names the offset.
test("NEGATIVE: a zone-less stamp is not read as local time", () => {
	const parsed = parseStamp("2026-09-14 22:27:36");
	const asLocal = Date.parse("2026-09-14T22:27:36");
	const offsetMs =
		new Date(2026, 8, 14, 22, 27, 36).getTimezoneOffset() * 60_000;
	if (offsetMs !== 0) {
		assert.notEqual(
			parsed,
			asLocal,
			"parsed the harness's own UTC stamp as local time"
		);
	}
	// True in every zone, including UTC: the parse must equal the UTC reading whatever the host is set to.
	assert.equal(parsed, Date.parse("2026-09-14T22:27:36Z"));
	// Stated as `parsed` rather than as a difference: node's strict equal separates -0 from 0, and under
	// UTC the difference is -0.
	assert.equal(
		parsed,
		asLocal - offsetMs,
		"the parse must sit exactly the host's offset away from the local reading"
	);
});

// The test above only separates UTC from local when the host is not UTC, and CI runners are. A regression of
// the exact defect this file exists for would pass every CI leg, so the parse is also run in a child process
// with a zone forced on it. Asia/Tokyo because +09:00 is unambiguous and has no DST.
test("the UTC reading holds on a host that is not UTC, which CI never is", () => {
	const clock = new URL("../soak/soak-clock.mjs", import.meta.url).href;
	const printed = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { parseStamp } from ${JSON.stringify(clock)};\nconsole.log(parseStamp("2026-09-14 22:27:36"));`,
		],
		{ env: { ...process.env, TZ: "Asia/Tokyo" }, encoding: "utf8" }
	).trim();
	assert.equal(
		Number(printed),
		Date.UTC(2026, 8, 14, 22, 27, 36),
		"under TZ=Asia/Tokyo the stamp was read as local time, which is the defect this file fixes"
	);
});

test("an anchor that names its own zone is left in it", () => {
	assert.equal(
		parseStamp("2026-09-14T22:27:36Z"),
		Date.UTC(2026, 8, 14, 22, 27, 36)
	);
	assert.equal(
		parseStamp("2026-09-14T17:27:36-05:00"),
		Date.UTC(2026, 8, 14, 22, 27, 36)
	);
	assert.equal(
		parseStamp("2026-09-14T22:27:36+00:00"),
		Date.UTC(2026, 8, 14, 22, 27, 36)
	);
});

// The caller checks Number.isFinite and starts the clock now. It must get NaN, not a wrong time.
test("NEGATIVE: text that is not a time is NaN rather than a plausible instant", () => {
	for (const bad of ["", "not a time", "soak", "2026-13-45 99:99:99"]) {
		assert.ok(
			Number.isNaN(parseStamp(bad)),
			`${JSON.stringify(bad)} parsed to something`
		);
	}
});

test("what stamp writes is what parseStamp reads, to the second", () => {
	const text = stamp();
	assert.match(
		text,
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
		"the on-disk shape the logs and the anchor share"
	);
	const parsed = parseStamp(text);
	assert.ok(Number.isFinite(parsed));
	assert.ok(
		Math.abs(parsed - Date.now()) < 60_000,
		"a stamp taken now must read back as now, in any zone"
	);
});
