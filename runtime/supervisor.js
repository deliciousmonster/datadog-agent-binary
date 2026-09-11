// Who holds the agents up. Released Harper has no sidecar API, so the bundled guard is the other half; one
// agent per node comes from a PID lock either way and only the holder changes.

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Pinned to one exact version, never a range: Harper runs `npm install` when it installs a component, so a
// caret here would let a customer's node resolve a guard no test in this repo has run against.
import {
	argvOf,
	fingerprint,
	guard,
	identify as identifyPid,
} from "@deliciousmonster/harper-process-guard";
import { describeSpawnFailure } from "./agent-exit.js";
import { writeConfigFiles } from "./config.js";

// No released Harper has `scope.processes` - harper@5.2.9 is latest and its Scope carries no such member - so
// this answers false on every node a customer can run today, and the guard below is the only shipping path.
const supervisesNatively = (scope) =>
	typeof scope?.processes?.start === "function";

// The state a supervisor never reached, in the shape both of them report. `started` is what answers "is it
// running": `exited: false` here means it never ran, not that it still does.
export const unstarted = (agent, error) => ({
	name: agent.name,
	title: agent.title,
	kind: agent.kind,
	started: false,
	adopted: false,
	exited: false,
	restarts: 0,
	error,
});

// What the NATIVE path publishes about the reaper, where the object comes from a Harper this package does not
// ship and may carry anything. The guard's own reaper state is a documented shape and is published whole.
const REAPER_FIELDS = ["name", "started", "adopted", "error"];
const knownReaperFields = (reaper) =>
	reaper &&
	Object.fromEntries(
		REAPER_FIELDS.filter((field) => reaper[field] !== undefined).map(
			(field) => [field, reaper[field]]
		)
	);

// Mutated, never copied: the guard writes this same object for the life of the node - a death, a restart,
// a give-up - and a copy taken here freezes the status endpoint on what was true at boot.
const identify = (state, agent) =>
	Object.assign(state, {
		name: agent.name,
		title: agent.title,
		kind: agent.kind,
	});

// Symmetric with the guard path's own notes: an operator reading the boot log sees this line, and a
// caller reading status.supervisionReport sees the same words, not just the absence of `kind: "guard"`.
const GUARD_UNUSED_NOTE =
	"the bundled process guard is present but unused: this Harper supervises the agents natively, so the guard never runs.";

// Harper's own sidecar, one call per process; it writes the config files behind its own sweep. Also the seam
// test/support/component.js fakes, so most of the component's supervision tests run through this branch.
const harperSupervisor = (scope, log) => ({
	kind: "harper",
	async start(agents, { configFiles, fingerprintParts }) {
		log.warn(`Datadog supervisor: ${GUARD_UNUSED_NOTE}`);
		const processes = await Promise.all(
			agents.map((agent) =>
				scope.processes
					.start({
						name: agent.name,
						title: agent.title,
						command: agent.command,
						args: agent.args,
						// On BOTH: start() writes after its own sweep, so naming them on one alone lets the
						// other spawn before the files exist.
						configFiles,
						fingerprint: fingerprintParts,
						exitHint: agent.exitHint,
						verify: agent.verify,
					})
					.then((state) => {
						// Only here: the guard reports its own verdicts through the log it was handed.
						if (state.verified !== true) {
							log.error(
								`Datadog supervisor: the ${agent.title} started but did not verify: ${state.verifyDetail ?? "no detail"}`
							);
						}
						return identify(state, agent);
					})
					.catch((error) =>
						unstarted(agent, describeSpawnFailure(error, agent.command))
					)
			)
		);
		return {
			processes,
			reaper: knownReaperFields(scope.processes.reaper),
			report: [GUARD_UNUSED_NOTE],
		};
	},
});

/**
 * A guard lock file: pid on line one, version on line two, and a JSON record carrying the argv on line three.
 * Returns undefined for anything it cannot read as one, so a caller treats an unreadable lock as no lock.
 *
 * @param {string} file
 * @returns {{ pid: number, version: number, argv: string[] } | undefined}
 */
export function readGuardLock(file) {
	let lines;
	try {
		lines = readFileSync(file, "utf-8").split("\n");
	} catch {
		return undefined;
	}
	const pid = Number.parseInt(lines[0], 10);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const version = Number.parseInt(lines[1], 10) || 0;
	let argv = [];
	try {
		const record = JSON.parse(lines.slice(2).join("\n"));
		if (
			Array.isArray(record?.argv) &&
			record.argv.every((a) => typeof a === "string")
		)
			argv = record.argv;
	} catch {
		// A lock written before the argv line, or a half-written one: identity is simply not established.
	}
	return { pid, version, argv };
}

/**
 * The reaper as it is now, rather than as bootstrap left it. The guard builds its ReaperState once and the
 * status copied it, so a reaper killed at 01:43 on 2026-09-09 was still reported `started` with its dead pid
 * ten minutes later, and the chaos run that killed it recorded a recovery that never happened. Processes
 * already get this treatment through currentVerdict; the reaper was the one thing left reporting boot state.
 *
 * @param {Record<string, unknown> | undefined} reaper @param {string | undefined} pidDir
 */
export function currentReaper(reaper, pidDir) {
	if (!reaper || !pidDir) return reaper;
	const name = typeof reaper.name === "string" ? reaper.name : REAPER_NAME;
	const held = readGuardLock(join(pidDir, `${name}.pid`));
	if (held && identifyPid(held.pid, held.argv) === "match") {
		// The pid too: a reaper that died and was replaced by another thread runs under a number this
		// thread's boot state never saw.
		return { ...reaper, started: true, pid: held.pid };
	}
	const why = !held
		? `no lock for ${name} under ${pidDir}`
		: argvOf(held.pid) === null
			? `${name}'s lock names pid ${held.pid}, which nothing holds`
			: `${name}'s lock names pid ${held.pid}, which is running something else`;
	return {
		...reaper,
		started: false,
		pid: undefined,
		error: `${why}. Nothing is reaping this node's agents: if it dies without running its exit handlers, they outlive it.`,
	};
}

// The reaper takes its own lock beside the agents', so its name is what a second component sharing the
// directory would collide on; this one names the package rather than taking the guard's generic default.
const REAPER_NAME = "datadog-agent-reaper";

/**
 * Harper's own spawn keeps a pid file per process name under <root>/pids and, when the file names a pid
 * that answers kill(pid, 0), returns that pid instead of spawning. After a restart the kernel reissues
 * pids, and a thread of Harper itself answers for one, so the file has to go before the guard asks.
 * Removing it signals nothing. A file naming the real process, or a dead one, is Harper's to keep.
 *
 * @param {string | null} root @param {Array<{ name: string; argv?: readonly string[]; script?: string }>} named
 * @param {import("@deliciousmonster/harper-process-guard").Log} log
 */
export function clearStaleHarperPidFiles(root, named, log) {
	if (!root) return;
	for (const { name, argv, script } of named) {
		const file = join(root, "pids", `${name}.pid`);
		let pid;
		try {
			pid = Number.parseInt(readFileSync(file, "utf-8"), 10);
		} catch {
			continue;
		}
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const running = argvOf(pid);
		if (running === null) continue;
		const ours = argv
			? identifyPid(pid, argv) === "match"
			: running.some((argument) => argument.endsWith(script ?? "\u0000"));
		if (ours) continue;
		try {
			unlinkSync(file);
			log.warn(
				`Datadog supervisor: removed ${file}, Harper's own pid file for ${name}: it named pid ${pid}, which ` +
					`is running \`${running.join(" ")}\`, and Harper would have handed that pid back as the ${name} ` +
					`instead of starting one.`
			);
		} catch (error) {
			log.error(
				`Datadog supervisor: could not remove ${file}, which names pid ${pid} running something else: ` +
					`${error.message}. Harper will hand that pid back as the ${name} rather than start one.`
			);
		}
	}
}

/** The bundled guard, one call for both agents. `spawn` is the entry module's own, which is the one Harper constrains. */
/**
 * What the node has, for a thread that has nothing. Harper's constrained spawn hands back a pid it never
 * identified, and the guard refuses one running something else, so a thread can end with `started: false`
 * while the node's agent is up and healthy under another thread. Observed three times on 2026-09-08 and
 * 09: the core agent's spawn was handed the trace-agent's pid. The refusal is a diagnostic, not the
 * node's health, and the endpoint answers "is this agent running" for the node.
 *
 * The lock is the node's own record, so an agent is reported only when a live process still identifies
 * against the argv the lock names. `refused` keeps the thread's own story rather than losing it.
 *
 * A thread that watched its own agent die re-reads for the opposite reason. The guard's `exited` is
 * documented as "true once this thread has seen it die, so a status surface stops reading healthy", and it
 * leaves `started` alone, because a deliberate stop is not a failed start. Reading only `started` therefore
 * published a dead agent as running: on 2026-09-10 a SIGTERM to the core agent took the guard's deliberate
 * branch, which releases the lock and does not restart, and `/DatadogStatus/` reported that agent started
 * and verified for the five minutes it was gone, with the soak logging `guard TT` throughout.
 *
 * That second reading is gated on the guard, because the lock is the guard's record and no other
 * supervisor keeps one. Where Harper supervises natively there is nothing to re-read and Harper's own
 * answer is the node's answer.
 *
 * @param {Record<string, any>} state @param {string | undefined} pidDir
 * @param {string} [supervision] `kind` of the supervisor that produced this state.
 */
export function nodeProcess(state, pidDir, supervision = "guard") {
	if (!state || !pidDir || !state.name) return state;
	const unstartedHere = state.started === false;
	const diedHere = state.exited === true && supervision === "guard";
	if (!unstartedHere && !diedHere) return state;
	const held = readGuardLock(join(pidDir, `${state.name}.pid`));
	if (!held || identifyPid(held.pid, held.argv) !== "match")
		// Nothing of this name is running on the node. For a thread that never started one that is already
		// what the state says; for a thread whose own agent died it is the correction. The dead pid stays:
		// `started: false` says it is not running, and which pid died is what an operator reads the log for.
		return diedHere ? { ...state, started: false } : state;
	return {
		...state,
		started: true,
		adopted: true,
		exited: false,
		pid: held.pid,
		// No verdict has been taken against this pid by this thread, which is what makes the reader retake
		// one rather than publish the refusal as a health state.
		verified: undefined,
		verifyDetail: undefined,
		verifiedPid: null,
		error: undefined,
		refused: state.error,
	};
}

/** How often a thread checks the reaper is still there, and the longest it waits after a failed relaunch. */
export const REAPER_WATCH_MS = 60_000;
const REAPER_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Keep a reaper on the node. Nothing relaunched one before: chaos killed the reaper on the 2026-09-09
 * soak at 01:43 and the node ran without orphan cleanup until the next restart forty minutes later,
 * while the status reported it started. The check is a lock read and one identification, so a thread
 * that finds a healthy reaper has done almost nothing; only an absent one reaches `relaunch`, which is
 * `guard({ processes: [], reaper })` and takes the same lock every thread already contends for, so one
 * thread spawns and the rest adopt.
 *
 * @param {object} options
 * @param {string} options.pidDir @param {Record<string, unknown>} options.reaper
 * @param {() => Promise<unknown>} options.relaunch @param {import("@deliciousmonster/harper-process-guard").Log} options.log
 * @param {number} [options.everyMs] @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @returns {{ stop: () => void, tick: () => Promise<'present'|'relaunched'|'failed'|'backoff'> }}
 */
/**
 * The guard's process descriptors for this node's agents.
 *
 * An agent that declares `env` gets it spread over this process's own, because naming `env` at all replaces
 * the whole environment rather than adding to it, and DD_API_KEY and DD_SITE reach the agents no other way.
 * An agent that declares none is left without `spawnOptions`, so it inherits exactly as it did before.
 *
 * @param {readonly Record<string, any>[]} agents @param {NodeJS.ProcessEnv} [inherited]
 */
export function guardDescriptors(agents, inherited = process.env) {
	return agents.map((agent) => ({
		name: agent.name,
		title: agent.title,
		binaryPath: agent.command,
		args: agent.args,
		exitHint: agent.exitHint,
		verify: agent.verify,
		...(agent.env
			? { spawnOptions: { env: { ...inherited, ...agent.env } } }
			: {}),
	}));
}

export function keepReaperAlive({
	pidDir,
	reaper,
	relaunch,
	log,
	everyMs = REAPER_WATCH_MS,
	setTimer = setInterval,
}) {
	let backoffUntil = 0;
	let wait = everyMs;
	let running = false;

	const tick = async () => {
		// One relaunch at a time per thread: a spawn plus its lock claim can outlast the interval.
		if (running) return "present";
		if (currentReaper(reaper, pidDir)?.started) {
			wait = everyMs;
			return "present";
		}
		if (Date.now() < backoffUntil) return "backoff";
		running = true;
		try {
			await relaunch();
			const now = currentReaper(reaper, pidDir);
			if (now?.started) {
				wait = everyMs;
				log.warn(
					`Datadog supervisor: the reaper was gone and has been relaunched as pid ${now.pid}.`
				);
				return "relaunched";
			}
			// It did not come back. Widen the gap rather than spawn every minute against whatever is
			// refusing, and say so once per attempt so the reason reaches a log an operator reads.
			wait = Math.min(wait * 2, REAPER_BACKOFF_MAX_MS);
			backoffUntil = Date.now() + wait;
			log.error(
				`Datadog supervisor: relaunching the reaper left none running; next attempt in ${Math.round(wait / 1000)}s. ${now?.error ?? ""}`
			);
			return "failed";
		} catch (error) {
			wait = Math.min(wait * 2, REAPER_BACKOFF_MAX_MS);
			backoffUntil = Date.now() + wait;
			log.error(
				`Datadog supervisor: relaunching the reaper threw: ${error instanceof Error ? error.message : String(error)}. Next attempt in ${Math.round(wait / 1000)}s`
			);
			return "failed";
		} finally {
			running = false;
		}
	};

	const timer = setTimer(() => {
		tick().catch(() => {});
	}, everyMs);
	// Never the reason a worker thread stays alive.
	timer?.unref?.();
	return { stop: () => clearInterval(timer), tick };
}

const guardSupervisor = (log, spawn) => ({
	kind: "guard",
	async start(agents, { runtime, configFiles, fingerprintParts }) {
		// Harper's start() writes these itself; on this path nothing else will, and both agents read them.
		writeConfigFiles(configFiles, log);
		clearStaleHarperPidFiles(
			runtime.root,
			[
				...agents.map((agent) => ({
					name: agent.name,
					argv: [agent.command, ...agent.args],
				})),
				// The guard builds the reaper's own argv; its script name is the one stable thing to match on.
				{ name: REAPER_NAME, script: "/reaper.js" },
			],
			log
		);
		const reaperConfig = {
			name: REAPER_NAME,
			logFile: runtime.paths.reaperLog,
			// Harper records its own pid here, so a restart inside the grace window keeps the agents
			// running for the replacement node to adopt.
			...(runtime.root
				? { replacementPidFile: join(runtime.root, "hdb.pid") }
				: {}),
		};
		let result;
		try {
			result = await guard({
				pidDir: runtime.paths.pidDir,
				spawn,
				log,
				version: fingerprint(...fingerprintParts),
				// What makes the fingerprint a replacement rather than a second lock holder: without it a rotated
				// key leaves the old agent running under no lock, so not even the reaper below can stop it again.
				stopOrphans: true,
				processes: guardDescriptors(agents),
				reaper: reaperConfig,
			});
		} catch (error) {
			// Anything guard() does not catch itself reaches here, and no enumeration of those stays true: the
			// last one written missed ctx.log.info. It starts the agents in order and rejects out of the one
			// it was on, so an agent ahead of it is running under a committed lock with nothing watching it.
			const message =
				`${error instanceof Error ? error.message : String(error)}. Neither agent is reported ` +
				`started because the call threw before it reported either; an agent it had already spawned ` +
				`is still running unsupervised, under a lock in ${runtime.paths.pidDir}`;
			log.error(
				`Datadog supervisor: the guard call for both agents threw: ${error.stack ?? message}`
			);
			return {
				// Not describeSpawnFailure: its ENOEXEC/EACCES/ENOENT translations are harperSupervisor's
				// per-agent contract, where the error IS that one agent's own spawn rejection. Here the cause
				// is unproven to be about either binary, so both agents get the same raw message.
				processes: agents.map((agent) => unstarted(agent, message)),
				report: [message],
			};
		}
		if (result.reaper) {
			// processes: [] is the reaper half on its own. Same lock, same arbitration, no agent touched.
			keepReaperAlive({
				pidDir: runtime.paths.pidDir,
				reaper: result.reaper,
				log,
				relaunch: () =>
					guard({
						pidDir: runtime.paths.pidDir,
						spawn,
						log,
						version: fingerprint(...fingerprintParts),
						stopOrphans: false,
						processes: [],
						reaper: reaperConfig,
					}),
			});
		}
		return {
			processes: result.processes.map((state, index) =>
				identify(state, agents[index])
			),
			// Whole: the guard's index.js built this and its ReaperState typedef is the shape. Filtering it here
			// dropped the reaper's own pid, which is the one field an operator needs to find the process.
			reaper: result.reaper,
			report: result.report,
		};
	},
});

// The one place either supervisor is chosen. Everything downstream takes what this returns and never reads
// `scope.processes` again, so a second reading cannot disagree with the first.
export const supervisorFor = (scope, { log, spawn }) =>
	supervisesNatively(scope)
		? harperSupervisor(scope, log)
		: guardSupervisor(log, spawn);
