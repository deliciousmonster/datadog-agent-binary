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
 * @param {import("./log.js").Log} log
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
				processes: agents.map((agent) => ({
					name: agent.name,
					title: agent.title,
					binaryPath: agent.command,
					args: agent.args,
					exitHint: agent.exitHint,
					verify: agent.verify,
				})),
				reaper: {
					name: REAPER_NAME,
					logFile: runtime.paths.reaperLog,
					// Harper records its own pid here, so a restart inside the grace window keeps the agents
					// running for the replacement node to adopt.
					...(runtime.root
						? { replacementPidFile: join(runtime.root, "hdb.pid") }
						: {}),
				},
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
