// Per-process memory and CPU for the processes this node supervises, as a named series something can alert
// on. `system.processes.*` is the Python `process` integration and this build ships no Python; Live Processes
// is Go and running, but it publishes to the Processes intake rather than the metrics intake, so nothing in
// it is queryable or alertable. Measured on the shipped binary: no `process.*` or `system.*` metric name is
// compiled in at all.
//
// The series publishes under `system.processes.*`, the namespace the Python check uses, because a series
// under a private name is one nobody's existing dashboard or monitor finds. It was `harper.processes.*`
// first, on the argument that Datadog does not reserve the namespace so a counterfeit would be accepted and
// two sources would merge. That risk is real; it is answered rather than avoided. This build has no
// interpreter, so the `process` check cannot run in the agent this component spawns, and a live
// `conf.d/process.d/conf.yaml` makes this stand down. `DD_HARPER_PROCESS_METRICS_PREFIX` restores the
// private namespace for a node that wants the separation.
//
// What is filled is a subset. `process.py` also emits cpu.pct, mem.vms, open_file_descriptors, the io
// counters and the page-fault rates, all of which need /proc reads this does not do. A dashboard that
// charts those beside mem.rss shows one series populated and the rest empty, which is the cost of sharing
// the namespace and is stated on the status endpoint rather than left to be discovered.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

/**
 * What this node sends, and how often.
 *
 * A boolean, not the presence of a config file. Datadog gates an *integration* on a `conf.d/<check>.d/`
 * file because the agent cannot know what you want monitored; `process.py` refuses an instance without a
 * `search_string`, `pid` or `pid_file` for exactly that reason. This is not an integration. It measures the
 * processes this component spawned, so it knows its own subject, which puts it in the same class as
 * `apm_config.enabled` and `process_config.process_collection.enabled` -- both of which this package already
 * renders as booleans. Installing the plugin is the operator asking for the data.
 *
 * On by default, because the series is small: six gauges per group, tagged by env, host and group. The cost
 * knobs are the ones an operator already knows from the check this replaces, with Datadog's own semantics:
 * `min_collection_interval` for cadence and `metric_patterns` where exclude beats include on overlap.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function settings(env = process.env) {
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
 * The namespace the Python `process` check publishes, which is the one a stock dashboard queries.
 *
 * Publishing here was the wrong call the first time. The argument against it was that Datadog does not
 * reserve the namespace server-side, so a counterfeit would be accepted and two sources would merge
 * silently. That risk is real and it is not this package's: this build excludes Python, so the `process`
 * check cannot run in the agent this component spawns, and `standDownFor` below covers the case where an
 * operator has arranged for something else to fill the namespace.
 *
 * What the argument missed is who pays. A series under a private name is one nobody's existing dashboard or
 * monitor finds, so "the data is there under a different name" costs the operator the work of rewriting
 * every query, which is the opposite of what shipping it was for.
 *
 * The metric names underneath were already Datadog's: `number`, `threads`, `mem.rss`, and `.avg`/`.max`/
 * `.min` are read straight off `ATTR_TO_METRIC` in `process.py`. Only the prefix and the tag key differed.
 */
export const DEFAULT_PREFIX = "system.processes";

/** What this package used before, kept as the documented way to opt out of sharing the namespace. */
export const PRIVATE_PREFIX = "harper.processes";

/**
 * Whether something else on this node is already filling `system.processes.*`, so this should stand down.
 *
 * The signal is a live `conf.d/process.d/conf.yaml`. That is how the agent is told to run the Python
 * `process` check, and Datadog ships only a `conf.yaml.example`, so a real one is an operator's deliberate
 * act. This build cannot run that check today, having no interpreter, but the file still says what the
 * operator intends and standing down on it is what keeps a later change from producing two sources.
 *
 * Not detectable from here: a second, separate Datadog agent on the same host with the check configured.
 * Nothing this process can read distinguishes that from no agent at all, so an operator in that position
 * sets DD_HARPER_PROCESS_METRICS_PREFIX and the detail line on the status endpoint says so.
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
		// `process_name` is what process.py tags with (`tags.extend(['process_name:{}'.format(self.name)...`)
		// and therefore what a stock dashboard groups by, so sharing the namespace without it would put the
		// data somewhere no existing query looks. `process_group` stays beside it: it is the same value under
		// the name this component's own status uses, and dropping it would break anything already built here.
		lines: dogstatsdLines(prefix, metrics, {
			...tags,
			process_name: group,
			process_group: group,
		}),
	};
}

/** The emitter claim lives beside the guard's own locks, so one directory holds everything this node arbitrates. */
export const CLAIM_FILE = "process-metrics.claim";

/**
 * How long a claim survives without a refresh. Three cadences rather than one, so an emitter that misses a
 * tick to a slow read does not hand the series to a second thread and double every gauge for one interval.
 */
export const claimStaleMs = (intervalSeconds) => intervalSeconds * 3000;

/**
 * Which thread sends. Harper runs many worker threads and every one of them loads this component, so an
 * ungated timer would emit the same gauges once per thread and multiply `number` and `mem.rss` by the thread
 * count. The guard already arbitrates the agents this way; this is the same shape for the series.
 *
 * A claim is a file holding `<holder> <timestamp>`. The holder refreshes it on every tick, which is what
 * makes takeover automatic: a thread that dies stops refreshing, and after `staleMs` the next tick from any
 * other thread takes it. There is no unlock path for that reason.
 *
 * @param {object} options
 * @param {string} options.dir @param {string} options.holder @param {number} options.staleMs
 * @param {number} [options.now] @param {typeof readFileSync} [options.read] @param {typeof writeFileSync} [options.write]
 * @returns {boolean} whether the caller may emit this tick
 */
export function claimEmitter({
	dir,
	holder,
	staleMs,
	now = Date.now(),
	read = readFileSync,
	write = writeFileSync,
}) {
	const file = join(dir, CLAIM_FILE);
	let held;
	try {
		held = String(read(file, "utf-8")).trim().split(/\s+/);
	} catch {
		// No claim yet, or one this thread cannot read. Either way nobody demonstrably holds it.
		held = [];
	}
	const [heldBy, stamp] = held;
	const at = Number(stamp);
	// A stamp ahead of `now` reads as live, not as expired. Every claimant is a worker thread inside one
	// Harper process and they share a clock, so the only way to see the future is a clock correction under a
	// living holder; calling that stale would hand the series to a second sender while the first still runs.
	// It resolves itself on the holder's next tick, which restamps with the corrected clock.
	const live = Number.isFinite(at) && now - at < staleMs;
	if (live && heldBy !== holder) return false;
	try {
		write(file, `${holder} ${now}\n`);
	} catch {
		// An unwritable pidDir is the guard's problem to report, and it already does. Emitting anyway would
		// put every thread on the wire, which is the one outcome the claim exists to prevent.
		return false;
	}
	return true;
}

/**
 * Send one reading. UDP, because that is what DogStatsD listens on and what every tracer's runtime metrics
 * already use; a dropped packet costs one interval of one gauge and nothing retries it, which is the right
 * trade for a level that is resent 15 seconds later.
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
 * The cadence. One timer per thread, gated by the claim above, so the node emits one series however many
 * threads Harper runs.
 *
 * `members()` is called per tick rather than captured: the pids it reports change under chaos, and a captured
 * list would keep measuring a process the guard has already replaced.
 *
 * @param {object} options
 * @param {() => {name: string, pid?: number, self?: boolean}[]} options.members
 * @param {string} options.pidDir @param {string} options.holder @param {number} options.port
 * @param {Record<string,string>} [options.tags] @param {import("./log.js").Log} [options.log]
 * @param {NodeJS.ProcessEnv} [options.env] @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {typeof sendDogstatsd} [options.send]
 * @returns {{ stop: () => void, tick: () => Promise<'sent'|'not-owner'|'nothing'|'failed'>, intervalSeconds: number }}
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
	const resolved = settings(env);
	const groups = () => {
		const all = members();
		return [
			["harper", all.filter((m) => m.self)],
			["datadog-agents", all.filter((m) => !m.self)],
		].filter(([, m]) => m.length > 0);
	};
	const tick = async () => {
		if (
			!claimEmitter({
				dir: pidDir,
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
				`Datadog supervisor: could not send the harper.processes.* series to DogStatsD on ` +
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
 * Start this thread's `harper.processes.*` timer and describe what it will do, for the status endpoint.
 *
 * Members are read per tick rather than captured, so a pid the guard replaced under chaos is measured as
 * the process the node runs now rather than the one it started. Only the claim holder sends; every other
 * thread's timer costs a file read.
 *
 * @param {object} options
 * @param {string} options.pidDir
 * @param {string} options.confd
 * @param {number} options.port DogStatsD.
 * @param {import('./log.js').Log} options.log
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
	const resolved = settings();
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
	// Sharing `system.processes.*` is only safe while nothing else fills it. A live conf.d/process.d/ is
	// the operator saying they intend the real check to, so this stands down rather than becoming a second
	// source.
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
