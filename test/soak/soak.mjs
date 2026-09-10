#!/usr/bin/env node
// A long run against a real Harper container: steady load on the shop, chaos on a randomly staggered
// schedule, and one status row a minute from the agents' own intake counters and the container's
// resource use. Everything it reads is real; nothing is mocked. Runs detached for as long as it is
// told and stops on SIGTERM.
//
//   node test/soak/soak.mjs            # 48 hours, 20 req/s, chaos every 10 to 30 minutes
//   SOAK_HOURS=0.1 SOAK_GAP_MIN=1,2 SOAK_SKIP=wrong-api-key-10min node test/soak/soak.mjs   # a six-minute smoke
//
// The Datadog API key is read from ~/.config/datadog/API_KEY at the moment a container is created and
// never logged; the break-the-intake action replaces it with zeros across a recreate, then restores it.

import { execFile, execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Harper's own self-signed certificate on 9926.

const run = promisify(execFile);
const CONTAINER = process.env.SOAK_CONTAINER ?? "harper-demo";
const VOLUME = process.env.SOAK_VOLUME ?? "harper-demo-vol";
const IMAGE = process.env.SOAK_IMAGE ?? "harperfast/harper:5.2.9";
const BASE = "https://localhost:9926";
const AUTH = "Basic " + Buffer.from("admin:password").toString("base64");
const ROOT = "/home/harperdb/harper";
const NAMES = ["datadog-trace-agent", "datadog-agent", "datadog-agent-reaper"];
const HOURS = Number(process.env.SOAK_HOURS ?? 48);
const RPS = Number(process.env.SOAK_RPS ?? 20);
const KEY_MIN = Number(process.env.SOAK_KEY_MIN ?? 10);
const [GAP_MIN, GAP_MAX] = (process.env.SOAK_GAP_MIN ?? "10,30")
	.split(",")
	.map(Number);
const OUT = process.env.SOAK_OUT ?? join(process.cwd(), "soak-out");
mkdirSync(OUT, { recursive: true });
const STATUS_TSV = join(OUT, "status.tsv");
const CHAOS_LOG = join(OUT, "chaos.log");

const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (line) => console.log(`${stamp()} ${line}`);
const chaosLog = (line) => {
	log(`CHAOS ${line}`);
	appendFileSync(CHAOS_LOG, `${stamp()} ${line}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = async (cmd) =>
	(
		await run("docker", ["exec", CONTAINER, "sh", "-c", cmd], {
			maxBuffer: 8 << 20,
		})
	).stdout;
const docker = (...args) => run("docker", args, { maxBuffer: 8 << 20 });

// ---------------------------------------------------------------------------------------------------
// Load: a fixed rate spread over a handful of workers, paths discovered from the shop's own listing.

const load = { sent: 0, ok: 0, failed: 0, latencyMs: [], multiplier: 1 };
let paths = ["/", "/products"];
async function discoverPaths() {
	try {
		const html = await (await fetch(`${BASE}/products`)).text();
		const found = [
			...new Set(
				[...html.matchAll(/href="(\/products\/[^"?#]+)"/g)].map((m) => m[1])
			),
		];
		if (found.length) paths = ["/", "/products", ...found.slice(0, 8)];
	} catch {
		// The next discovery gets it.
	}
}
async function hit() {
	const path = paths[Math.floor(Math.random() * paths.length)];
	const started = Date.now();
	load.sent++;
	try {
		const response = await fetch(`${BASE}${path}`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (response.ok) load.ok++;
		else load.failed++;
		await response.arrayBuffer();
	} catch {
		load.failed++;
	}
	load.latencyMs.push(Date.now() - started);
}
function startLoad(stop) {
	let inFlight = 0;
	const tick = () => {
		if (stop.stopped) return;
		const wanted = Math.round((RPS * load.multiplier) / 10); // ten ticks a second
		for (let i = 0; i < wanted && inFlight < 200; i++) {
			inFlight++;
			hit().finally(() => inFlight--);
		}
	};
	const timer = setInterval(tick, 100);
	const discover = setInterval(discoverPaths, 60_000);
	discoverPaths();
	return () => {
		clearInterval(timer);
		clearInterval(discover);
	};
}

// ---------------------------------------------------------------------------------------------------
// Reads: the plugin's own status, both agents' expvars, container resource use.

async function status() {
	try {
		const response = await fetch(`${BASE}/DatadogStatus/`, {
			headers: { authorization: AUTH },
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}
async function expvars() {
	try {
		const out = await sh(
			"curl -s -m 5 http://127.0.0.1:5000/debug/vars; echo; echo ---SPLIT---; curl -sk -m 5 https://127.0.0.1:5012/debug/vars"
		);
		const [core, trace] = out.split("---SPLIT---").map((part) => {
			try {
				return JSON.parse(part.trim());
			} catch {
				return null;
			}
		});
		return { core, trace };
	} catch {
		return { core: null, trace: null };
	}
}
async function containerStats() {
	try {
		const { stdout } = await docker(
			"stats",
			"--no-stream",
			"--format",
			"{{json .}}",
			CONTAINER
		);
		const s = JSON.parse(stdout);
		return { cpu: s.CPUPerc, mem: s.MemUsage.split(" / ")[0] };
	} catch {
		return { cpu: "-", mem: "-" };
	}
}
async function rss(pids) {
	try {
		// One token per pid, whatever happens to it. The first version fell back with `printf "- "`, which
		// dash reads as an option ("printf: Illegal option -"), so a pid that had gone emitted an error
		// instead of a placeholder and every column after it shifted left by one. `${v:--}` fills the gap
		// and `printf %s` never sees the dash as a flag.
		const out = await sh(
			`for pid in ${pids.map((pid) => Number(pid) || 0).join(" ")}; do ` +
				`v=$(awk '/VmRSS/{printf "%d", $2/1024}' /proc/$pid/status 2>/dev/null); ` +
				`printf '%s ' "\${v:--}"; done`
		);
		const columns = out.trim().split(/\s+/);
		// Never fewer than asked for: a short row is what silently mislabels the two agents' memory.
		return pids.map((_, index) => columns[index] ?? "-");
	} catch {
		return pids.map(() => "-");
	}
}

// ---------------------------------------------------------------------------------------------------
// Chaos: one action at a time, chosen at random without an immediate repeat, on gaps drawn at random.

const chaos = {
	last: "none",
	at: null,
	count: 0,
	results: [],
	busyUntil: 0,
	pending: [],
};
const pidOf = (s, kind) => s?.processes?.find((p) => p.kind === kind)?.pid;

/**
 * The pid of a running agent, waited for rather than read once. A status read that lands while the node is
 * restarting answers null, and `kill -9 undefined` is what that used to become: chaos #37 on 2026-09-09 was
 * recorded as "could not be applied" and that round killed nothing. Undefined here means the agent is not
 * running to be killed, which is a skip rather than a failure.
 *
 * @param {"trace"|"core"} kind
 * @returns {Promise<number|undefined>}
 */
async function livePid(kind, attempts = 6) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const pid = pidOf(await status(), kind);
		if (Number.isInteger(pid) && pid > 0) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	return undefined;
}

/** What an action returns when the thing it perturbs is not there to perturb. */
const notApplicable = (why) => ({ skip: why });

const ACTIONS = {
	async "kill-trace-agent"() {
		const pid = await livePid("trace");
		if (!pid) return notApplicable("no trace-agent pid in the status to kill");
		await sh(`kill -9 ${pid}`);
		return {
			expect: "the guard restarts it under a new pid and it verifies",
			check: async (before) =>
				(await status())?.processes?.find((p) => p.kind === "trace"),
			before: pid,
		};
	},
	async "kill-core-agent"() {
		const pid = await livePid("core");
		if (!pid) return notApplicable("no core agent pid in the status to kill");
		await sh(`kill -9 ${pid}`);
		return {
			expect: "the guard restarts it under a new pid and it verifies",
			check: async () =>
				(await status())?.processes?.find((p) => p.kind === "core"),
			before: pid,
		};
	},
	async "kill-reaper"() {
		const pid = (await status())?.reaper?.pid;
		await sh(`kill -9 ${pid}`);
		return {
			expect:
				"the agents keep running; a reaper is relaunched on the next thread start or restart",
			check: async () => (await status())?.reaper,
			before: pid,
		};
	},
	async restart() {
		await docker("restart", CONTAINER);
		return {
			expect: "both agents come back verified after the restart",
			check: async () => (await status())?.processes,
		};
	},
	async "restart-seeded-pid-1"() {
		await sh(
			`for n in ${NAMES.join(" ")}; do printf '1\\n' > ${ROOT}/pids/$n.pid; done`
		);
		await docker("restart", CONTAINER);
		return {
			expect:
				"the plugin removes Harper's three pid files naming pid 1 and both agents come back verified",
			check: async () => (await status())?.processes,
		};
	},
	async "stop-trace-agent-60s"() {
		const pid = await livePid("trace");
		if (!pid) return notApplicable("no trace-agent pid in the status to stop");
		await sh(`kill -STOP ${pid}`);
		chaos.busyUntil = Date.now() + 90_000;
		chaos.pending.push(() => sh(`kill -CONT ${pid}`).catch(() => {}));
		setTimeout(() => sh(`kill -CONT ${pid}`).catch(() => {}), 60_000);
		return {
			expect:
				"delivery reads unavailable or idle while stopped, then recovers after SIGCONT",
			check: async () => (await status())?.delivery?.verdict,
		};
	},
	async "pause-30s"() {
		await docker("pause", CONTAINER);
		chaos.busyUntil = Date.now() + 60_000;
		chaos.pending.push(() => docker("unpause", CONTAINER).catch(() => {}));
		setTimeout(() => docker("unpause", CONTAINER).catch(() => {}), 30_000);
		return {
			expect: "requests fail for 30 s, then everything resumes with no restart",
			check: async () => (await status())?.processes,
		};
	},
	async "burst-10x-5min"() {
		load.multiplier = 10;
		chaos.busyUntil = Date.now() + 6 * 60_000;
		chaos.pending.push(() => (load.multiplier = 1));
		setTimeout(() => (load.multiplier = 1), 5 * 60_000);
		return {
			expect: "latency rises, nothing restarts, traces keep flowing",
			check: async () => (await status())?.delivery?.verdict,
		};
	},
	async "wrong-api-key-10min"() {
		await recreate("0".repeat(32));
		chaos.busyUntil = Date.now() + (KEY_MIN + 3) * 60_000;
		const restore = () =>
			recreate(realApiKey()).catch((error) =>
				chaosLog(`restore failed: ${error.message}`)
			);
		chaos.pending.push(restore);
		setTimeout(restore, KEY_MIN * 60_000);
		return {
			expect:
				"delivery reads rejected within a few minutes; after the key is restored it reads delivering or traces-unconfirmed",
			check: async () => (await status())?.delivery?.verdict,
		};
	},
};

const realApiKey = () =>
	readFileSync(join(homedir(), ".config", "datadog", "API_KEY"), "utf8").trim();
async function recreate(apiKey) {
	await docker("rm", "-f", CONTAINER).catch(() => {});
	await run("docker", [
		"run",
		"--rm",
		"--entrypoint",
		"sh",
		"-v",
		`${VOLUME}:${ROOT}`,
		IMAGE,
		"-c",
		`rm -f ${ROOT}/hdb.pid`,
	]);
	await run(
		"docker",
		[
			"run",
			"-d",
			"--name",
			CONTAINER,
			"-v",
			`${VOLUME}:${ROOT}`,
			"-p",
			"9926:9926",
			"-p",
			"9925:9925",
			"-e",
			"DD_API_KEY",
			"-e",
			"DD_SITE=datadoghq.com",
			"-e",
			"DD_ENV=demo",
			"-e",
			"DD_SERVICE=harper-ecommerce",
			"-e",
			"DD_HOSTNAME=harper-demo",
			"-e",
			"DD_LOGS_ENABLED=true",
			IMAGE,
		],
		{ env: { ...process.env, DD_API_KEY: apiKey } }
	);
}

async function fireChaos() {
	const skipped = (process.env.SOAK_SKIP ?? "").split(",").filter(Boolean);
	const names = Object.keys(ACTIONS).filter(
		(name) => name !== chaos.last && !skipped.includes(name)
	);
	const pool = names.length
		? names
		: Object.keys(ACTIONS).filter((n) => !skipped.includes(n));
	const name = pool[Math.floor(Math.random() * pool.length)];
	chaos.count++;
	chaos.last = name;
	chaos.at = Date.now();
	try {
		const { expect, check, before, skip } = await ACTIONS[name]();
		// Nothing was perturbed, so there is nothing to read back in two minutes. Counted and logged rather
		// than silent: a run whose chaos keeps skipping is a run that is not testing what it claims to.
		if (skip) {
			chaos.results.push({ name, summary: `skipped: ${skip}` });
			chaosLog(`#${chaos.count} ${name} skipped: ${skip}`);
			return;
		}
		chaosLog(
			`#${chaos.count} ${name}${before ? ` (pid ${before})` : ""}: ${expect}`
		);
		// Read the outcome after the world has had time to move; two minutes covers a restart and a verify,
		// and a read that lands inside a pause is retried for a minute more.
		setTimeout(async () => {
			let observed;
			for (let attempt = 0; attempt < 6; attempt++) {
				observed = await check(before).catch(
					(error) => `read failed: ${error.message}`
				);
				if (observed !== undefined && observed !== null) break;
				await sleep(10_000);
			}
			const summary =
				JSON.stringify(observed, [
					"name",
					"pid",
					"verified",
					"restarts",
					"started",
					"verdict",
				]) ?? String(observed);
			chaos.results.push({ name, summary });
			chaosLog(`#${chaos.count} ${name} after 2 min: ${summary.slice(0, 300)}`);
		}, 120_000);
	} catch (error) {
		chaosLog(`#${chaos.count} ${name} could not be applied: ${error.message}`);
	}
}
const nextGap = () => (GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN)) * 60_000;

// ---------------------------------------------------------------------------------------------------
// The status row.

const COLUMNS = [
	["time", 19],
	["up", 7],
	["cpu%", 8],
	["mem", 9],
	["harperMB", 8],
	["traceMB", 7],
	["coreMB", 6],
	["req/s", 5],
	["fail", 5],
	["p95ms", 6],
	["sup", 5],
	["verified", 8],
	["restarts", 8],
	["verdict", 19],
	["traces", 7],
	["spans", 6],
	["statsOK", 7],
	["statsErr", 8],
	["traceOK", 7],
	["traceErr", 8],
	["fwdOK", 6],
	["logsSent", 8],
	["logsErr", 7],
	["chaos", 32],
];
/** What a writer reports turned away, as errors/retries: a zero in either alone hides a wrong key. */
const refusals = (writer) =>
	writer ? `${writer.errors ?? "-"}/${writer.retries ?? "-"}` : "-";

const header = () =>
	COLUMNS.map(([name, width]) => name.padEnd(width)).join(" ");
/** Columns already reported as too narrow, so one rotted width is one line and not one per minute. */
const truncated = new Set();

const row = (values) =>
	COLUMNS.map(([name, width]) => {
		const value = String(values[name] ?? "-");
		// Silent truncation is how 33 rows of this run lost the `%` off a CPU reading over 100, which reads as
		// a plain number. The TSV carries the value whole, so the fix is to say the width rotted, once.
		if (value.length > width && !truncated.has(name)) {
			truncated.add(name);
			console.log(
				`soak: the ${name} column is ${width} wide and ${JSON.stringify(value)} needs ${value.length}. ` +
					`status.tsv has it whole; widen COLUMNS.`
			);
		}
		return value.slice(0, width).padEnd(width);
	}).join(" ");
let rows = 0;
/**
 * When this run's clock started, which is not when this process started.
 *
 * A restart to load a fix is part of the test, not the end of it, so the clock has to survive one. The
 * anchor lives in `started` under the output directory and is written once: a run that finds the file
 * adopts the time in it and keeps counting, and only a run into an empty directory writes a new one. It was
 * written unconditionally before, so each of this run's three restarts overwrote the origin and `up`
 * counted from zero again, which lost 26 hours of elapsed time from every line that reports it.
 */
function anchorStart(dir) {
	const file = join(dir, "started");
	try {
		const written = readFileSync(file, "utf-8").trim();
		const at = Date.parse(written.replace(" ", "T"));
		if (Number.isFinite(at)) {
			log(
				`soak: resuming the clock from ${written}, which this directory already carries`
			);
			return at;
		}
		log(
			`soak: ${file} reads "${written}", which is not a time; starting the clock now`
		);
	} catch {
		// No anchor here, so this is the first run into this directory.
	}
	writeFileSync(file, `${stamp()}\n`);
	return Date.now();
}

const startedAt = anchorStart(OUT);
let lastLoad = { sent: 0, ok: 0, failed: 0 };

async function statusRow() {
	const [s, vars, stats] = await Promise.all([
		status(),
		expvars(),
		containerStats(),
	]);
	const tracePid = pidOf(s, "trace");
	const corePid = pidOf(s, "core");
	// Harper's own node process is the biggest one; pid 1 is a one-megabyte shim in front of it.
	const harperPid = await sh(
		`for d in /proc/[0-9]*; do p=$(basename $d); awk -v p=$p '/VmRSS/{print $2, p}' $d/status; done | sort -n | tail -1 | awk '{print $2}'`
	)
		.then((out) => Number(out.trim()) || 0)
		.catch(() => 0);
	const [harperMB, traceMB, coreMB] = await rss([
		harperPid,
		tracePid ?? 0,
		corePid ?? 0,
	]);
	const sent = load.sent - lastLoad.sent;
	const failed = load.failed - lastLoad.failed;
	lastLoad = { sent: load.sent, ok: load.ok, failed: load.failed };
	const sorted = load.latencyMs.splice(0).sort((a, b) => a - b);
	const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : "-";
	const forwarder = vars.core?.forwarder?.Transactions ?? {};
	const fwdOK =
		Object.values(forwarder.Success ?? {}).reduce(
			(sum, n) => sum + (Number(n) || 0),
			0
		) || forwarder.Success;
	const logs = vars.core?.["logs-agent"] ?? {};
	const d = s?.delivery ?? {};
	const values = {
		time: stamp(),
		up: `${((Date.now() - startedAt) / 3_600_000).toFixed(2)}h`,
		"cpu%": stats.cpu,
		mem: stats.mem,
		harperMB,
		traceMB,
		coreMB,
		"req/s": (sent / 60).toFixed(1),
		fail: failed,
		p95ms: p95,
		sup: s?.supervision ?? "-",
		verified: s
			? s.processes
					.map((p) =>
						p.verified === true ? "T" : p.verified === false ? "F" : "?"
					)
					.join("")
			: "-",
		restarts: s ? s.processes.map((p) => p.restarts).join("/") : "-",
		verdict: d.verdict ?? "-",
		traces: d.receiver?.tracesReceived ?? "-",
		spans: d.receiver?.spansReceived ?? "-",
		statsOK: d.statsWriter?.payloads ?? "-",
		// errors/retries, because the verdict reads both and a retry is what a wrong key produces first. Every
		// `rejected` row on the 2026-09-08 run showed statsErr=0 beside it: the intake 403s, the writer retries,
		// and Errors stays zero until it gives up, so the table carried no reason for its own verdict.
		statsErr: refusals(d.statsWriter),
		traceOK: d.traceWriter?.payloads ?? "-",
		traceErr: refusals(d.traceWriter),
		fwdOK: typeof fwdOK === "number" ? fwdOK : "-",
		logsSent: logs.LogsSent ?? "-",
		logsErr: logs.DestinationErrors ?? "-",
		chaos: chaos.at
			? `${chaos.last} ${Math.round((Date.now() - chaos.at) / 60_000)}m ago`
			: "none",
	};
	if (rows++ % 20 === 0) console.log(header());
	console.log(row(values));
	appendFileSync(
		STATUS_TSV,
		(rows === 1 ? COLUMNS.map(([n]) => n).join("\t") + "\n" : "") +
			COLUMNS.map(([n]) => values[n]).join("\t") +
			"\n"
	);
}

// ---------------------------------------------------------------------------------------------------

async function main() {
	log(
		`soak: ${HOURS}h at ${RPS} req/s against ${CONTAINER} (${IMAGE}); chaos every ${GAP_MIN}-${GAP_MAX} min; output under ${OUT}`
	);
	const stop = { stopped: false };
	const stopLoad = startLoad(stop);
	const end = Date.now() + HOURS * 3_600_000;
	let nextChaos = Date.now() + nextGap();
	const statusTimer = setInterval(
		() => statusRow().catch((error) => log(`status failed: ${error.message}`)),
		60_000
	);
	await statusRow();
	const finish = async () => {
		stop.stopped = true;
		stopLoad();
		clearInterval(statusTimer);
		for (const undo of chaos.pending.splice(0)) await undo();
		log(
			`soak: finished after ${((Date.now() - startedAt) / 3_600_000).toFixed(2)}h, ${chaos.count} chaos actions, ${load.sent} requests (${load.failed} failed)`
		);
		for (const r of chaos.results)
			log(`  ${r.name}: ${r.summary.slice(0, 200)}`);
		process.exit(0);
	};
	process.on("SIGTERM", finish);
	process.on("SIGINT", finish);
	while (Date.now() < end) {
		if (Date.now() >= nextChaos && Date.now() >= chaos.busyUntil) {
			await fireChaos();
			nextChaos = Date.now() + nextGap();
		}
		await sleep(5_000);
	}
	finish();
}

main().catch((error) => {
	log(`soak: fatal ${error.stack ?? error.message}`);
	process.exit(1);
});
