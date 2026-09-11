#!/usr/bin/env node
// One row per statistic, not per check: the current reading, the change since the reading before it, and the
// mean over everything recorded so far.

import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DIR =
	process.argv[2] && !process.argv[2].startsWith("--")
		? process.argv[2]
		: "soak-out";
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	if (!process.argv[i].startsWith("--")) continue;
	args.set(process.argv[i].slice(2), process.argv[i + 1] ?? "");
}
const CHECKS = join(DIR, "checks.tsv");
const FIELDS = [
	"time",
	"hosts",
	"apm_rps",
	"apm_err",
	"logs15m",
	"procs",
	"ram_ctr",
	"ram_vm",
	"swap_ctr",
	"swap_vm",
	"verdict",
	"verified",
	"chaos",
	"note",
];

/** "10.6K" and "1.78K" carry their magnitude in a suffix; "-" means the page showed nothing. */
function num(text) {
	if (text === undefined || text === null || text === "" || text === "-")
		return null;
	const match = String(text).match(/(-?[\d.]+)\s*([KMG])?/i);
	if (!match) return null;
	const scale = { k: 1e3, m: 1e6, g: 1e9 }[(match[2] ?? "").toLowerCase()] ?? 1;
	const value = Number.parseFloat(match[1]) * scale;
	return Number.isFinite(value) ? value : null;
}
const pair = (text, index) =>
	text ? num(String(text).split("/")[index]) : null;

if (args.has("hosts") || args.has("apm-rps") || args.has("logs")) {
	const row = {
		time: new Date().toISOString().slice(0, 19) + "Z",
		hosts: args.get("hosts") ?? "-",
		apm_rps: args.get("apm-rps") ?? "-",
		apm_err: args.get("apm-err") ?? "-",
		logs15m: args.get("logs") ?? "-",
		procs: args.get("procs") ?? "-",
		ram_ctr: pair(args.get("ram"), 0) ?? "-",
		ram_vm: pair(args.get("ram"), 1) ?? "-",
		swap_ctr: pair(args.get("swap"), 0) ?? "-",
		swap_vm: pair(args.get("swap"), 1) ?? "-",
		verdict: args.get("verdict") ?? "-",
		verified: args.get("verified") ?? "-",
		chaos: args.get("chaos") ?? "-",
		note: (args.get("note") ?? "-").replace(/\t/g, " "),
	};
	if (!existsSync(CHECKS)) writeFileSync(CHECKS, FIELDS.join("\t") + "\n");
	appendFileSync(CHECKS, FIELDS.map((f) => row[f]).join("\t") + "\n");
}

function readTsv(path) {
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	const head = lines.shift().split("\t");
	// A run restarted into the same directory appends its own header. Read as data it becomes a row whose every
	// field is a column name, and the parse of "p95ms" put a 95,000,000 ms high in the table on 2026-09-09.
	return lines
		.filter((line) => !line.startsWith(`${head[0]}\t`))
		.map((line) =>
			Object.fromEntries(line.split("\t").map((cell, i) => [head[i], cell]))
		);
}
const checks = readTsv(CHECKS);
const status = readTsv(join(DIR, "status.tsv"));

/**
 * GiB and MiB both to GB, so container memory reads on one scale across a run that crossed the boundary.
 * Parsed here rather than through num(): the G of "1.898GiB" is a unit, not a billion.
 */
const memGB = (text) => {
	const match = String(text ?? "").match(/(-?[\d.]+)\s*(GiB|MiB|KiB)?/i);
	if (!match) return null;
	const value = Number.parseFloat(match[1]);
	if (!Number.isFinite(value)) return null;
	const unit = (match[2] ?? "GiB").toLowerCase();
	return unit === "gib"
		? value
		: unit === "mib"
			? value / 1024
			: value / 1024 / 1024;
};

const STATS = [
	{
		label: "Datadog hosts",
		src: checks,
		get: (r) => num(r.hosts),
		unit: "",
		dp: 0,
	},
	{
		label: "APM requests/s",
		src: checks,
		get: (r) => num(r.apm_rps),
		unit: "",
		dp: 1,
	},
	{
		label: "APM errors",
		src: checks,
		get: (r) => num(r.apm_err),
		unit: "",
		dp: 0,
	},
	{
		label: "Log lines / 15 min",
		src: checks,
		get: (r) => num(r.logs15m),
		unit: "",
		dp: 0,
	},
	{
		label: "Processes listed",
		src: checks,
		get: (r) => num(r.procs),
		unit: "",
		dp: 0,
	},
	{ separator: "node, sampled every minute" },
	{
		label: "Load driven",
		src: status,
		get: (r) => num(r["req/s"]),
		unit: " req/s",
		dp: 1,
	},
	{
		label: "Failed requests",
		src: status,
		get: (r) => num(r.fail),
		unit: "/min",
		dp: 0,
	},
	{
		label: "Latency p95",
		src: status,
		get: (r) => num(r.p95ms),
		unit: " ms",
		dp: 0,
	},
	{
		label: "Container CPU",
		src: status,
		get: (r) => num(r["cpu%"]),
		unit: "%",
		dp: 1,
	},
	{
		label: "Container RAM",
		src: status,
		get: (r) => memGB(r.mem),
		unit: " GB",
		dp: 2,
	},
	{
		label: "Harper RSS",
		src: status,
		get: (r) => num(r.harperMB),
		unit: " MB",
		dp: 0,
	},
	{
		label: "Core agent RSS",
		src: status,
		get: (r) => num(r.coreMB),
		unit: " MB",
		dp: 0,
	},
	{
		label: "Trace-agent RSS",
		src: status,
		get: (r) => num(r.traceMB),
		unit: " MB",
		dp: 0,
	},
	{
		label: "Spans received",
		src: status,
		get: (r) => num(r.spans),
		unit: "/min",
		dp: 0,
	},
	{ separator: "container, read at each check" },
	{
		label: "Container swap",
		src: checks,
		get: (r) => num(r.swap_ctr),
		unit: " MB",
		dp: 0,
	},
	{
		label: "Docker VM RAM used",
		src: checks,
		get: (r) => num(r.ram_vm),
		unit: " GB",
		dp: 1,
	},
	{
		label: "Docker VM swap used",
		src: checks,
		get: (r) => num(r.swap_vm),
		unit: " MB",
		dp: 0,
	},
];

const fmt = (value, dp, unit) =>
	value === null
		? "-"
		: value.toLocaleString("en-US", {
				minimumFractionDigits: dp,
				maximumFractionDigits: dp,
			}) + unit;
const rows = [];
for (const stat of STATS) {
	if (stat.separator) {
		rows.push({ separator: stat.separator });
		continue;
	}
	const values = stat.src.map(stat.get).filter((v) => v !== null);
	if (values.length === 0) {
		rows.push({ label: stat.label, cells: ["-", "-", "-"] });
		continue;
	}
	const current = values.at(-1);
	const previous = values.length > 1 ? values.at(-2) : null;
	// A change against a previous zero has no percentage; the absolute step is what there is to say.
	const delta =
		previous === null
			? "-"
			: previous === 0
				? current === 0
					? "0"
					: `+${fmt(current - previous, stat.dp, "")}`
				: `${current >= previous ? "+" : ""}${(((current - previous) / previous) * 100).toFixed(1)}%`;
	rows.push({
		label: stat.label,
		cells: [
			fmt(current, stat.dp, stat.unit),
			delta,
			// No high or low. A 48-hour run's extremes are its chaos rounds and its startup, which is what they
			// reported: a 15,005 ms p95 from one wedged minute and a 0.00 GB container from the second before it booted.
			fmt(
				values.reduce((a, b) => a + b, 0) / values.length,
				stat.dp,
				stat.unit
			),
		],
	});
}

// Ruled rather than space-aligned.
const HEAD = ["statistic", "current", "delta", "mean"];
const widths = HEAD.map((h, i) =>
	Math.max(
		h.length,
		...rows
			.filter((r) => r.cells)
			.map((r) => (i === 0 ? r.label.length : r.cells[i - 1].length))
	)
);
const PAD = 1;
const bar = (left, join, right) =>
	left + widths.map((w) => "─".repeat(w + PAD * 2)).join(join) + right;
/** A rule that closes the columns above it and opens them again below, for a section heading band. */
const band = (left, right) =>
	left +
	"─".repeat(widths.reduce((a, w) => a + w + PAD * 2, 0) + widths.length - 1) +
	right;
const line = (cells) =>
	"│" +
	cells
		.map((c, i) => {
			const text = String(c);
			const padded =
				i === 0 ? text.padEnd(widths[i]) : text.padStart(widths[i]);
			return " ".repeat(PAD) + padded + " ".repeat(PAD);
		})
		.join("│") +
	"│";
const heading = (text) =>
	"│" +
	" ".repeat(PAD) +
	text.padEnd(
		widths.reduce((a, w) => a + w + PAD * 2, 0) + widths.length - 1 - PAD * 2
	) +
	" ".repeat(PAD) +
	"│";

const out = [bar("┌", "┬", "┐"), line(HEAD), bar("├", "┼", "┤")];
for (const row of rows) {
	if (row.separator) {
		out.push(bar("├", "┴", "┤"), heading(row.separator), bar("├", "┬", "┤"));
	} else out.push(line([row.label, ...row.cells]));
}
out.push(bar("└", "┴", "┘"));
const latest = checks.at(-1);
if (latest)
	out.push(
		"",
		`last check ${latest.time}  verdict ${latest.verdict}  verified ${latest.verified}  chaos ${latest.chaos}`,
		latest.note && latest.note !== "-" ? `note: ${latest.note}` : ""
	);

const table =
	out
		.filter((l) => l !== undefined)
		.join("\n")
		.replace(/\n+$/, "") + "\n";
writeFileSync(join(DIR, "checks-table.txt"), table);
process.stdout.write(table);
