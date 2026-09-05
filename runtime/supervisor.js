// Who holds the agents up. Released Harper has no sidecar API, so the bundled guard is the other half; one
// agent per node comes from a PID lock either way and only the holder changes.

import { join } from "node:path";

// A submodule, imported by path: a bare specifier would make the guard an install, and the install is what
// left a dangling symlink that broke `npm ci` on every fresh checkout.
import { fingerprint, guard } from "../guard/src/index.js";
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
			// Whole: guard/src/index.js built this and its ReaperState typedef is the shape. Filtering it here
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
