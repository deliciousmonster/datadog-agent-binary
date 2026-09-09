// Per-process memory and CPU for the processes this node supervises, as a named series something can alert
// on. `system.processes.*` is the Python `process` integration and this build ships no Python; Live Processes
// is Go and running, but it publishes to the Processes intake rather than the metrics intake, so nothing in
// it is queryable or alertable. Measured on the shipped binary: no `process.*` or `system.*` metric name is
// compiled in at all.
//
// The series is named `harper.processes.*`, not `system.processes.*`. Datadog does not reserve that namespace
// server-side and the counterfeit would be accepted, which is the reason not to: it would carry a different
// tag set, cadence and aggregation while being indistinguishable from the real check, so anyone who later
// installs the Python integration gets two sources silently merged.

import { readFileSync } from "node:fs";

/** Bytes per /proc kB field. */
const KB = 1024;

/**
 * What one process costs, or null when this platform cannot say.
 *
 * Linux answers from /proc. macOS and Windows have no equivalent a Node process can read without either
 * spawning `ps`/`Get-CimInstance` on a schedule, which Harper's constrained spawn would make an operator
 * allowlist, or a native addon, which would end this package's "no install scripts" property. Reporting
 * nothing is correct there; reporting the Go agents' `memstats` would not be, because that is heap and not
 * resident memory. Measured 2026-09-09: the core agent read 129 MiB resident while publishing `Sys` of 64.
 *
 * @param {number} pid @param {string} [platform] @param {(p: string) => string} [read]
 * @returns {{ rssBytes: number, threads: number } | null}
 */
export function readProcess(
	pid,
	platform = process.platform,
	read = undefined
) {
	if (platform !== "linux") return null;
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const readFile = read ?? ((p) => readFileSync(p, "utf-8"));
	let status;
	try {
		status = readFile(`/proc/${pid}/status`);
	} catch {
		// The process went away between listing it and reading it, which is ordinary under chaos.
		return null;
	}
	const field = (name) => {
		const m = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status);
		return m ? Number(m[1]) : undefined;
	};
	const rssKb = field("VmRSS");
	if (rssKb === undefined) return null;
	return { rssBytes: rssKb * KB, threads: field("Threads") ?? 0 };
}

/**
 * This process's own cost, which needs no /proc and is the same on every platform.
 *
 * Harper and the reaper are Node, so `process.memoryUsage().rss` is their real resident size. That is why
 * two of the four supervised processes are covered everywhere and only the two Go agents are not.
 *
 * @param {NodeJS.Process} [self]
 */
export function selfProcess(self = process) {
	const { rss } = self.memoryUsage();
	return { rssBytes: rss, threads: 0 };
}

/**
 * The aggregation the Python check publishes, over whatever this node could read.
 *
 * `number` counts what was found, not what was asked for: a supervised process the platform cannot measure
 * is absent from the series rather than present as a zero, so a monitor sees no data instead of a false floor.
 *
 * @param {readonly ({ rssBytes: number, threads: number } | null)[]} samples
 */
export function aggregate(samples) {
	const found = samples.filter((s) => s !== null);
	if (found.length === 0) return { number: 0 };
	const rss = found.map((s) => s.rssBytes);
	const threads = found.map((s) => s.threads);
	return {
		number: found.length,
		"mem.rss": rss.reduce((a, b) => a + b, 0),
		"mem.rss.avg": Math.round(rss.reduce((a, b) => a + b, 0) / rss.length),
		"mem.rss.max": Math.max(...rss),
		"mem.rss.min": Math.min(...rss),
		threads: threads.reduce((a, b) => a + b, 0),
	};
}

/** A DogStatsD tag list, sorted so two identical readings produce one series rather than two. */
const tagList = (tags) =>
	Object.entries(tags)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}:${String(v).replace(/[|,#\n]/g, "_")}`)
		.sort();

/**
 * The wire form. Gauges only: every field here is a level, and a counter would be wrong on a restart.
 *
 * @param {string} prefix @param {Record<string, number>} metrics @param {Record<string, string>} tags
 */
export function dogstatsdLines(prefix, metrics, tags = {}) {
	const suffix = tagList(tags);
	const tail = suffix.length ? `|#${suffix.join(",")}` : "";
	return Object.entries(metrics)
		.filter(([, v]) => Number.isFinite(v))
		.map(([name, value]) => `${prefix}.${name}:${value}|g${tail}`);
}

/**
 * One reading for one named process group, ready to send.
 *
 * @param {{ name: string, pid?: number, self?: boolean }[]} members
 * @param {{ group: string, prefix?: string, tags?: Record<string,string>, platform?: string }} options
 */
export function processSeries(members, options) {
	const {
		group,
		prefix = "harper.processes",
		tags = {},
		platform = process.platform,
	} = options;
	const samples = members.map((m) =>
		m.self ? selfProcess() : readProcess(m.pid, platform)
	);
	const metrics = aggregate(samples);
	return {
		metrics,
		measured: samples.filter((s) => s !== null).length,
		asked: members.length,
		lines: dogstatsdLines(prefix, metrics, { ...tags, process_group: group }),
	};
}
