// Did one soak leg pass? The ladder in soak-ladder.sh asks this after every run, and a single failure
// anywhere sends every leg back to the shortest rung, so the rules here decide whether the matrix ever
// advances. They are written from what five legs actually produced, and each one cost a run to learn.
//
// Read as a module (`checkLeg`) or run as a CLI: `node soak-check.mjs <leg-dir> [--expect-sup guard]`.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** A leg is judged on the supervisor, which is what the matrix measures. */
const RULES = {
	/** A request that failed while nothing was being done to the node. */
	failuresOutsideChaos: "requests failed with no chaos in flight",
	/** The supervision path changed, or was never what this leg is meant to exercise. */
	wrongSupervision: "the supervision path is not the one this leg runs",
	/** Verification degraded while nothing was being done to the node. */
	verificationOutsideChaos:
		"an agent stopped verifying with no chaos in flight",
	/** A pipeline counter stopped climbing outside a chaos window. */
	pipelineStall: "a delivery pipeline stopped while nothing was being done",
	/** A chaos action could not be applied, so the leg tested less than it claims. */
	chaosNotApplied: "a chaos action could not be applied",
	/** The run ended early: fewer rows than a minute-per-row run of this length should produce. */
	endedEarly: "the run produced far fewer rows than its duration",
	/** Resident memory grew across the run beyond what a steady node does. */
	memoryGrowth: "resident memory grew across the run",
};

/** How much RSS growth between the first and last tenth of a run is a leak rather than noise. */
const MEMORY_GROWTH_LIMIT = 1.25;
/** A row is "quiet" when its chaos column says nothing is in flight or the last action is well past. */
const QUIET_AFTER_MIN = 12;

const toGiB = (v) => {
	const m = /^([\d.]+)\s*(GiB|MiB|KiB|B)?$/.exec(String(v).trim());
	if (!m) return null;
	const n = Number(m[1]);
	return { GiB: n, MiB: n / 1024, KiB: n / 1048576, B: n / 1073741824 }[
		m[2] ?? "GiB"
	];
};

/** Whether nothing was being done to the node when this row was written. */
export function rowIsQuiet(chaosCell) {
	const cell = String(chaosCell ?? "").trim();
	if (!cell || cell === "none" || cell === "-") return true;
	const ago = /(\d+)m ago$/.exec(cell);
	return ago ? Number(ago[1]) >= QUIET_AFTER_MIN : false;
}

/**
 * Judge one leg's output directory.
 *
 * @param {string} dir The leg's SOAK_OUT.
 * @param {{ expectSup?: string, hours?: number, strictDelivery?: boolean }} [options]
 * @returns {{ pass: boolean, failures: string[], warnings: string[], stats: Record<string, any> }}
 */
export function checkLeg(dir, options = {}) {
	const failures = [];
	const warnings = [];
	const stats = {};

	const tsv = join(dir, "status.tsv");
	if (!existsSync(tsv))
		return {
			pass: false,
			failures: ["no status.tsv: the run produced nothing"],
			warnings,
			stats,
		};

	const lines = readFileSync(tsv, "utf-8").trim().split("\n");
	const header = lines[0].split("\t");
	const col = (name) => header.indexOf(name);
	const rows = lines.slice(1).map((l) => l.split("\t"));
	stats.rows = rows.length;
	if (!rows.length)
		return {
			pass: false,
			failures: ["status.tsv has a header and no rows"],
			warnings,
			stats,
		};

	const iSup = col("sup"),
		iVer = col("verified"),
		iFail = col("fail");
	const iChaos = col("chaos"),
		iMem = col("mem"),
		iUp = col("up");

	// The steady reading is whatever the leg held for most of its quiet rows; a leg is judged against
	// itself rather than against a hardcoded TTTTT, because a macOS leg has two agents and a container five.
	const tally = {};
	for (const r of rows)
		if (rowIsQuiet(r[iChaos]) && r[iVer] && r[iVer] !== "-")
			tally[r[iVer]] = (tally[r[iVer]] ?? 0) + 1;
	const steady = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
	stats.steady = steady;

	let failRows = 0,
		failReqs = 0,
		verDeviations = 0,
		supDeviations = 0;
	for (const r of rows) {
		const quiet = rowIsQuiet(r[iChaos]);
		if (quiet && Number(r[iFail]) > 0) {
			failRows++;
			failReqs += Number(r[iFail]);
		}
		if (quiet && r[iVer] && r[iVer] !== "-" && steady && r[iVer] !== steady)
			verDeviations++;
		if (
			options.expectSup &&
			r[iSup] &&
			r[iSup] !== "-" &&
			r[iSup] !== options.expectSup
		)
			supDeviations++;
	}
	stats.failRowsOutsideChaos = failRows;
	stats.failReqsOutsideChaos = failReqs;
	if (failRows)
		failures.push(
			`${RULES.failuresOutsideChaos}: ${failReqs} across ${failRows} row(s)`
		);
	if (verDeviations)
		failures.push(
			`${RULES.verificationOutsideChaos}: ${verDeviations} row(s) away from ${steady}`
		);
	if (supDeviations)
		failures.push(
			`${RULES.wrongSupervision}: ${supDeviations} row(s) not '${options.expectSup}'`
		);

	// Memory: compare the first tenth against the last tenth, so a restart's cold tail cannot fake a drop.
	const slice = Math.max(1, Math.floor(rows.length / 10));
	const mean = (rs) => {
		const v = rs
			.map((r) => toGiB(r[iMem]))
			.filter((n) => typeof n === "number" && n > 0);
		return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
	};
	const first = mean(rows.slice(0, slice)),
		last = mean(rows.slice(-slice));
	if (first && last) {
		stats.memFirstGiB = Number(first.toFixed(3));
		stats.memLastGiB = Number(last.toFixed(3));
		if (last / first > MEMORY_GROWTH_LIMIT)
			failures.push(
				`${RULES.memoryGrowth}: ${first.toFixed(2)} -> ${last.toFixed(2)} GiB`
			);
	}

	// The run has to have lasted: a row a minute, so a 1h rung owes roughly 60.
	const finalUp = Number(String(rows.at(-1)[iUp] ?? "").replace("h", "")) || 0;
	stats.hours = finalUp;
	if (options.hours && finalUp < options.hours * 0.9)
		failures.push(
			`${RULES.endedEarly}: reached ${finalUp}h of ${options.hours}h`
		);

	// The harness's own alarms, which know things this file cannot re-derive.
	const log = existsSync(join(dir, "nohup.log"))
		? readFileSync(join(dir, "nohup.log"), "utf-8")
		: "";
	const stallLines = log
		.split("\n")
		.filter(
			(l) => l.includes("STALL:") && !l.includes("delivery has read rejected")
		);
	stats.pipelineStalls = stallLines.length;
	if (stallLines.length)
		failures.push(`${RULES.pipelineStall}: ${stallLines.length} flagged`);

	const chaosLog = existsSync(join(dir, "chaos.log"))
		? readFileSync(join(dir, "chaos.log"), "utf-8")
		: "";
	const notApplied = chaosLog
		.split("\n")
		.filter((l) => l.includes("could not be applied"));
	stats.chaosNotApplied = notApplied.length;
	if (notApplied.length)
		failures.push(`${RULES.chaosNotApplied}: ${notApplied.length}`);
	stats.chaosActions = chaosLog
		.split("\n")
		.filter((l) => /^\d{4}-/.test(l) && !l.includes("after 2 min")).length;

	// Delivery refused outside chaos is recorded, and by default does not reset the ladder: three runs have
	// lost it to container DNS while the host resolved fine, and a public resolver is unreachable from
	// Docker Desktop, so the matrix would never advance. --strict-delivery makes it a failure.
	const deliveryStalls = log
		.split("\n")
		.filter((l) => l.includes("delivery has read rejected"));
	stats.deliveryStalls = deliveryStalls.length;
	if (deliveryStalls.length)
		(options.strictDelivery ? failures : warnings).push(
			`delivery read rejected with no chaos in flight (${deliveryStalls.length} flagged); check the trace-agent log before blaming this node`
		);

	return { pass: failures.length === 0, failures, warnings, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [dir, ...rest] = process.argv.slice(2);
	if (!dir) {
		console.error(
			"usage: soak-check.mjs <leg-dir> [--expect-sup guard|harper] [--hours N] [--strict-delivery]"
		);
		process.exit(2);
	}
	const arg = (name) => {
		const i = rest.indexOf(name);
		return i === -1 ? undefined : rest[i + 1];
	};
	const result = checkLeg(dir, {
		expectSup: arg("--expect-sup"),
		hours: arg("--hours") ? Number(arg("--hours")) : undefined,
		strictDelivery: rest.includes("--strict-delivery"),
	});
	console.log(`  ${result.pass ? "PASS" : "FAIL"}  ${dir}`);
	for (const [k, v] of Object.entries(result.stats))
		console.log(`    ${k}: ${v}`);
	for (const f of result.failures) console.log(`    FAIL: ${f}`);
	for (const w of result.warnings) console.log(`    warn: ${w}`);
	process.exit(result.pass ? 0 : 1);
}
