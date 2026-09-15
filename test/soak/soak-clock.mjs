/*
 * The run clock, split out of soak.mjs so the parse has a test. soak.mjs self-executes, and a date rule that
 * is only exercised by a 20-hour run is a rule nothing checks.
 *
 * The clock has to survive a restart: reloading the harness to pick up a fix is part of the test, not the end
 * of it, so the start time lives in a `started` file rather than in the process.
 */

/** Now, as the logs write it: UTC, with the zone stripped because every line in the file is UTC. */
export const stamp = () =>
	new Date().toISOString().slice(0, 19).replace("T", " ");

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A stamp this file wrote, back to a time. `stamp()` strips the zone, so the text names no offset and
 * `Date.parse` reads it as local: resuming in a UTC-5 zone put the clock five hours behind on 2026-09-15, and
 * a 48-hour run would have kept going for 53. The stamp is UTC, so say so before parsing. An anchor that does
 * carry a zone is left alone, since a hand-written one may be in any.
 *
 * @param {string} written @returns {number} ms since the epoch, or NaN when the text is not a time
 */
export function parseStamp(written) {
	const text = String(written).trim().replace(" ", "T");
	return Date.parse(ZONED.test(text) ? text : `${text}Z`);
}
