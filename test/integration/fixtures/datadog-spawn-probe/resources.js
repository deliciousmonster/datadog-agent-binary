/**
 * Probes Harper v5's spawn enforcement from inside a real Harper component and
 * writes what it observed to a JSONL file the test reads back.
 *
 * This runs at module load, which means once per worker thread. The PID-file lock
 * in security/jsLoader.ts is what turns N threads into one process, and the only
 * way to see that race is to be in every thread while it happens; an HTTP-driven
 * probe would reach whichever single thread served the request.
 *
 * `node:child_process` is not Node's here. Harper's module loader substitutes a
 * constrained version whose spawn/exec/execFile enforce
 * applications.allowedSpawnCommands and require an options.name. Reaching the
 * builtin by any other route would get the unconstrained one.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

const PROBE_DIR = process.env.DD_SPAWN_PROBE_DIR;
/** Allowlisted command used for the no-name probe. */
const PROBE_COMMAND = process.env.DD_SPAWN_PROBE_COMMAND;
/** Executable that exists but is deliberately absent from the allowlist. */
const DENIED_COMMAND = process.env.DD_SPAWN_PROBE_DENIED_COMMAND;
/** JSON: [{ name, command, args }]; one allowlisted spawn each. */
const TARGETS = JSON.parse(process.env.DD_SPAWN_PROBE_TARGETS || "[]");

const RESULTS_FILE = "probe-results.jsonl";

/**
 * One `appendFileSync` per record is what makes this safe across threads: a line
 * is written in one syscall, so threads interleave whole lines, not fragments.
 */
function record(entry) {
	appendFileSync(
		join(PROBE_DIR, RESULTS_FILE),
		JSON.stringify({ threadId, ...entry }) + "\n"
	);
}

/**
 * Run one probe and record whether it threw. Which outcome is correct is asserted
 * in the test, not here, so a change in Harper's behaviour shows up as a failed
 * assertion instead of a fixture that quietly stopped probing.
 */
function probe(name, run) {
	try {
		record({ probe: name, threw: false, ...run() });
	} catch (error) {
		record({
			probe: name,
			threw: true,
			error: String(error?.message ?? error),
		});
	}
}

/** What a spawn returned, flattened so it survives JSON. */
function describeChild(child) {
	return {
		pid: child?.pid ?? null,
		// A real ChildProcess always has spawnargs, even under stdio:"inherit" where
		// stdout and stderr are null. Harper's ExistingProcessWrapper has neither,
		// which is how a caller tells the two apart.
		hasSpawnargs: Array.isArray(child?.spawnargs),
		hasStdout: Boolean(child?.stdout),
		hasKill: typeof child?.kill === "function",
		hasUnref: typeof child?.unref === "function",
	};
}

if (PROBE_DIR && PROBE_COMMAND) {
	// No `name` option. Harper rejects this outright; stock Node ignores the option
	// entirely, so a runtime where this succeeds is not enforcing.
	probe("no-name", () => describeChild(spawn(PROBE_COMMAND, [])));

	// An absolute path to a real executable that is not in
	// applications.allowedSpawnCommands. It is executable, so the only possible
	// reason to fail is the allowlist.
	probe("not-allowlisted", () =>
		describeChild(spawn(DENIED_COMMAND, [], { name: "probe-denied" }))
	);

	// Distinct names take distinct PID locks, which is what lets the core agent and
	// the trace-agent both run on one node.
	for (const target of TARGETS) {
		probe(`allowlisted:${target.name}`, () => {
			const child = spawn(target.command, target.args ?? [], {
				name: target.name,
			});
			const described = describeChild(child);
			// Only losers of the race get a wrapper, and its 1Hz liveness interval is
			// not unref'd, so leaving it referenced keeps that thread from ever going
			// idle. The winner's real ChildProcess stays referenced so its 'exit'
			// handler still fires and unlinks the PID file.
			if (!described.hasSpawnargs) child.unref?.();
			return described;
		});
	}

	record({ probe: "done", threw: false });
}
