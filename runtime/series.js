// What the processes cost, as a series something can alert on: Live Processes publishes to the Processes
// intake, so nothing it collects is queryable.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

import {
	claimSingleton,
	claimStaleMs,
	readProcess,
	selfProcess,
} from "@deliciousmonster/harper-process-guard";

import { LABEL } from "./datadog.js";

/**
 * What this node sends and how often. A boolean, not a config file: this is not an integration, it measures
 * the processes this component spawned. On by default, six gauges a group, with Datadog's own cost knobs.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function seriesSettings(env = process.env) {
	const flag = env.DD_HARPER_PROCESS_METRICS_ENABLED;
	const seconds = Number(env.DD_HARPER_PROCESS_METRICS_INTERVAL);
	const patterns = (raw) =>
		(raw ?? "")
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
	const prefix = String(env.DD_HARPER_PROCESS_METRICS_PREFIX ?? "").trim();
	return {
		// Anything but an explicit falsehood is on, so a typo cannot silently stop the data.
		enabled: !["false", "0", "no", "off"].includes(
			String(flag ?? "").toLowerCase()
		),
		intervalSeconds:
			Number.isFinite(seconds) && seconds > 0
				? seconds
				: DEFAULT_INTERVAL_SECONDS,
		// A trailing dot is the mistake an operator makes here, and it would put `system.processes..number`
		// on the wire, so it is stripped rather than honoured.
		prefix: prefix ? prefix.replace(/\.+$/, "") : DEFAULT_PREFIX,
		include: patterns(env.DD_HARPER_PROCESS_METRICS_INCLUDE),
		exclude: patterns(env.DD_HARPER_PROCESS_METRICS_EXCLUDE),
	};
}

/**
 * The namespace the Python check publishes, which is what a stock dashboard queries. Two sources merging is
 * a real risk and not this one's: no interpreter ships here, and standDownFor covers the operator who adds one.
 */
export const DEFAULT_PREFIX = "system.processes";

/** What this package used before, kept as the documented way to opt out of sharing the namespace. */
export const PRIVATE_PREFIX = "harper.processes";

/**
 * Whether something else already fills `system.processes.*`. The signal is a live conf.d/process.d/conf.yaml,
 * which Datadog ships only as an example, so a real one is deliberate. A second agent is not detectable here.
 *
 * @param {string | undefined} confdDir @param {(p: string) => unknown} [stat]
 */
export function standDownFor(confdDir, stat = undefined) {
	if (!confdDir) return false;
	const exists = stat ?? ((p) => existsSync(p));
	for (const name of ["conf.yaml", "conf.yml"])
		if (exists(join(confdDir, "process.d", name))) return true;
	return false;
}

/**
 * Datadog's `metric_patterns` semantics: include narrows, exclude removes, exclude wins on overlap.
 *
 * @param {Record<string, number>} metrics
 * @param {{ include?: readonly string[], exclude?: readonly string[] }} patterns
 */
export function applyPatterns(metrics, { include = [], exclude = [] } = {}) {
	const matches = (list, name) =>
		list.some((p) => {
			try {
				return new RegExp(p).test(name);
			} catch {
				// A malformed pattern matches nothing rather than throwing a status read.
				return false;
			}
		});
	return Object.fromEntries(
		Object.entries(metrics).filter(
			([name]) =>
				(include.length === 0 || matches(include, name)) &&
				!matches(exclude, name)
		)
	);
}

/** Datadog's own default cadence for a check, so the number an operator knows carries over. */
export const DEFAULT_INTERVAL_SECONDS = 15;

/**
 * The aggregation the Python check publishes, over what this node could read. `number` counts what was
 * found, so an unmeasurable process is absent rather than a zero and a monitor sees no data, not a floor.
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
 * @param {{ group: string, prefix?: string, tags?: Record<string,string>, platform?: string,
 *   include?: readonly string[], exclude?: readonly string[] }} options
 */
export function processSeries(members, options) {
	const {
		group,
		prefix = DEFAULT_PREFIX,
		tags = {},
		platform = process.platform,
	} = options;
	const samples = members.map((m) =>
		m.self ? selfProcess() : readProcess(m.pid, platform)
	);
	const metrics = applyPatterns(aggregate(samples), options);
	return {
		metrics,
		measured: samples.filter((s) => s !== null).length,
		asked: members.length,
		// `process_name` is what process.py tags with and what a stock dashboard groups by. `process_group` is
		// the same value under this component's own name, kept so nothing already built here breaks.
		lines: dogstatsdLines(prefix, metrics, {
			...tags,
			process_name: group,
			process_group: group,
		}),
	};
}

// Which thread sends, arbitrated beside the guard's own locks. An ungated timer emits these gauges once per
// worker thread, multiplying `number` and `mem.rss` by the thread count.
export const CLAIM_FILE = "process-metrics.claim";

/**
 * Send one reading over UDP, which is what DogStatsD listens on. A dropped packet costs one interval of one
 * gauge, which is the right trade for a level resent 15 seconds later.
 *
 * @param {readonly string[]} lines
 * @param {{ port: number, host?: string, socket?: { send: Function, close: Function } }} options
 * @returns {Promise<number>} lines actually handed to the socket
 */
export async function sendDogstatsd(
	lines,
	{ port, host = "127.0.0.1", socket }
) {
	if (lines.length === 0) return 0;
	const own = socket ?? (await import("node:dgram")).createSocket("udp4");
	try {
		// One packet, newline-separated: DogStatsD reads a multi-metric payload, and one send beats six.
		const payload = Buffer.from(lines.join("\n"));
		await new Promise((resolve, reject) =>
			own.send(payload, port, host, (error) =>
				error ? reject(error) : resolve(undefined)
			)
		);
		return lines.length;
	} finally {
		if (!socket) own.close();
	}
}

/**
 * The cadence: one timer per thread gated by the claim, so the node emits one series. `members()` is called
 * per tick, since a captured list keeps measuring a process the guard has already replaced.
 *
 * @param {object} options
 * @param {() => {name: string, pid?: number, self?: boolean}[]} options.members
 * @param {string} options.pidDir @param {string} options.holder @param {number} options.port
 * @param {Record<string,string>} [options.tags] @param {import("@deliciousmonster/harper-process-guard").Log} [options.log]
 * @param {NodeJS.ProcessEnv} [options.env] @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(lines: readonly string[], options: { port: number }) => unknown} [options.send] Only has to
 *   deliver. A caller's stand-in need not report a count, which is what the real one returns for its own log.
 * @returns {{ stop: () => void, tick: () => Promise<'sent'|'not-owner'|'nothing'|'failed'>, intervalSeconds: number, prefix: string }}
 */
export function startProcessSeries({
	members,
	pidDir,
	holder,
	port,
	tags = {},
	log,
	env = process.env,
	setTimer = setInterval,
	send = sendDogstatsd,
}) {
	const resolved = seriesSettings(env);
	const groups = () => {
		const all = members();
		/** @type {[string, { name: string, pid?: number, self?: boolean }[]][]} */
		const grouped = [
			["harper", all.filter((m) => m.self)],
			["datadog-agents", all.filter((m) => !m.self)],
		];
		return grouped.filter(([, m]) => m.length > 0);
	};
	const tick = async () => {
		if (
			!claimSingleton({
				dir: pidDir,
				file: CLAIM_FILE,
				holder,
				staleMs: claimStaleMs(resolved.intervalSeconds),
			})
		)
			return "not-owner";
		const lines = groups().flatMap(
			([group, m]) =>
				processSeries(m, {
					group,
					tags,
					prefix: resolved.prefix,
					include: resolved.include,
					exclude: resolved.exclude,
				}).lines
		);
		if (lines.length === 0) return "nothing";
		try {
			await send(lines, { port });
			return "sent";
		} catch (error) {
			// Once per failure, not once per tick forever: a DogStatsD that is down stays down for a while,
			// and a line a tick would bury the node's own logs under this component's retries.
			log?.warn?.(
				`${LABEL}: could not send the ${resolved.prefix}.* series to DogStatsD on ` +
					`127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`
			);
			return "failed";
		}
	};
	const timer = setTimer(() => {
		tick().catch(() => {});
	}, resolved.intervalSeconds * 1000);
	// A metrics timer must not be the reason a worker thread stays up.
	timer?.unref?.();
	return {
		stop: () => clearInterval(timer),
		tick,
		intervalSeconds: resolved.intervalSeconds,
		prefix: resolved.prefix,
	};
}

/**
 * Start this thread's timer and describe what it will do, for the status endpoint. Only the claim holder
 * sends; every other thread's timer costs a file read.
 *
 * @param {object} options
 * @param {string} options.pidDir
 * @param {string} options.confd
 * @param {number} options.port DogStatsD.
 * @param {import('@deliciousmonster/harper-process-guard').Log} options.log
 * @param {() => Array<{name: string, pid?: number, self?: boolean}>} options.members
 * @param {{ stop(): void } | undefined} options.previous This thread's existing timer, stopped first so a
 *   second startup cannot leave two of them running.
 * @returns {{ state: object, series: { stop(): void } | undefined }}
 */
export function scheduleSeries({
	pidDir,
	confd,
	port,
	log,
	members,
	previous,
}) {
	const resolved = seriesSettings();
	if (!resolved.enabled) {
		previous?.stop();
		return {
			series: undefined,
			state: {
				...resolved,
				emitting: false,
				detail: `off: DD_HARPER_PROCESS_METRICS_ENABLED is ${process.env.DD_HARPER_PROCESS_METRICS_ENABLED}`,
			},
		};
	}
	// Sharing the namespace is safe only while nothing else fills it, and a live conf.d/process.d/ is the
	// operator saying they intend the real check to.
	if (resolved.prefix === DEFAULT_PREFIX && standDownFor(confd)) {
		previous?.stop();
		return {
			series: undefined,
			state: {
				...resolved,
				emitting: false,
				detail:
					`standing down: ${join(confd, "process.d")} configures the Python \`process\` check, which owns ` +
					`${DEFAULT_PREFIX}.*. Set DD_HARPER_PROCESS_METRICS_PREFIX (${PRIVATE_PREFIX} is the documented ` +
					`alternative) to publish alongside it instead`,
			},
		};
	}
	previous?.stop();
	const series = startProcessSeries({
		pidDir,
		holder: `${process.pid}.${threadId}`,
		port,
		log,
		members,
	});
	return {
		series,
		state: {
			...resolved,
			emitting: true,
			detail:
				`sending ${series.prefix}.* to DogStatsD on 127.0.0.1:${port} every ` +
				`${series.intervalSeconds}s, from whichever thread holds the claim in ${pidDir}` +
				(series.prefix === DEFAULT_PREFIX
					? `. This is the namespace the Python \`process\` check owns, and this fills a subset of it: ` +
						`number, threads and mem.rss with its avg/max/min. cpu.pct, mem.vms, open_file_descriptors ` +
						`and the io counters are not collected and will read as no data`
					: ""),
		},
	};
}
