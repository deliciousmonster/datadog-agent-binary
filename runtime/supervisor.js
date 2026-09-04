// Who holds the agents up. Released Harper has no sidecar API, so the bundled guard is the other half; one
// agent per node comes from a PID lock either way and only the holder changes.

import { join } from "node:path";

// A submodule, imported by path: a bare specifier would make the guard an install, and the install is what
// left a dangling symlink that broke `npm ci` on every fresh checkout.
import { fingerprint, guard } from "../guard/src/index.js";
import { describeSpawnFailure } from "./agent-exit.js";
import { writeConfigFiles } from "./config.js";

// Released Harper's Scope has no `processes` at all, so its absence is the whole version check and no config
// selects between the two.
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

// What either supervisor publishes about the reaper. guard/src/index.js sets `error` both when the reaper
// never started and when it started and only its lock write failed, so `started` is what tells those apart.
const REAPER_FIELDS = ["name", "started", "adopted", "error"];
const reaperStatus = (reaper) =>
	reaper &&
	Object.fromEntries(
		REAPER_FIELDS.filter((field) => reaper[field] !== undefined).map(
			(field) => [field, reaper[field]]
		)
	);

// Symmetric with the guard path's own notes: an operator reading the boot log sees this line, and a
// caller reading status.supervisionReport sees the same words, not just the absence of `kind: "guard"`.
const GUARD_UNUSED_NOTE =
	"the bundled process guard is present but unused: this Harper supervises the agents natively, so the guard never runs.";

/** Harper's own sidecar, one call per process. It writes the config files behind its own sweep. */
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
						return {
							name: agent.name,
							title: agent.title,
							...state,
							kind: agent.kind,
						};
					})
					.catch((error) =>
						unstarted(agent, describeSpawnFailure(error, agent.command))
					)
			)
		);
		return {
			processes,
			reaper: reaperStatus(scope.processes.reaper),
			report: [GUARD_UNUSED_NOTE],
		};
	},
});

// The reaper takes its own lock beside the agents', so its name is what a second component sharing the
// directory would collide on; this one names the package rather than taking the guard's generic default.
const REAPER_NAME = "datadog-agent-reaper";

/** The bundled guard, one call for both agents. `spawn` is the entry module's own, which is the one Harper constrains. */
const guardSupervisor = (log, spawn) => ({
	kind: "guard",
	async start(agents, { runtime, configFiles, fingerprintParts }) {
		// Harper's start() writes these itself; on this path nothing else will, and both agents read them.
		writeConfigFiles(configFiles, log);
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
			// guard() catches claimLock, preflight, ctx.spawn(), and every commitLock/releaseLock write
			// internally, so none of those reach here. What still can: guard/src/supervise.js calls
			// child.on('error', ...) right after a successful ctx.spawn() returns, with no try/catch around
			// that call. spawn here is Harper's own constrained one, not node's plain child_process.spawn, so
			// a return value that is not a real EventEmitter throws synchronously there and rejects this whole
			// call - one error for both agents, not a verdict about either agent's binary.
			const message = error instanceof Error ? error.message : String(error);
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
			processes: result.processes.map((state, index) => ({
				...state,
				kind: agents[index].kind,
			})),
			reaper: reaperStatus(result.reaper),
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
