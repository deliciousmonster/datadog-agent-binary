/**
 * Harper component entry that runs the SHIPPED example supervisor and records its
 * status object for test/integration/harper-spawn.test.ts to assert on.
 *
 * dd-supervisor.js and conf.d/ are deliberately absent from this directory: the
 * test copies them from example/ into an assembled application at setup, so the
 * example stays the single source and the suite executes the exact file the
 * README tells operators to use. The relative import below is the pattern that
 * file documents as load-bearing; only modules Harper's own loader compiles get
 * the constrained child_process.
 *
 * This runs at module load, once per worker thread. The PID-file lock is the
 * behaviour under test, and the only way to observe the race is to be in every
 * thread while it happens; an HTTP-driven probe would reach whichever single
 * thread served the request.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { startDatadogAgents } from "./dd-supervisor.js";

const PROBE_DIR = process.env.DD_SPAWN_PROBE_DIR;
/** Allowlisted command for the no-name probe below. */
const PROBE_COMMAND = process.env.DD_SPAWN_PROBE_COMMAND;

/**
 * One `appendFileSync` per record is what makes this safe across threads: a line
 * is written in one syscall, so threads interleave whole lines, not fragments.
 */
function record(entry) {
	appendFileSync(
		join(PROBE_DIR, "probe-results.jsonl"),
		JSON.stringify({ threadId, ...entry }) + "\n"
	);
}

if (PROBE_DIR && PROBE_COMMAND) {
	// The one enforcement probe the example does not carry: Harper's mandatory
	// spawn `name`. The supervisor relies on it for the PID lock but never spawns
	// without one, so a runtime that ignores the option would pass every
	// supervisor assertion while enforcing nothing. The command IS allowlisted,
	// which pins any throw to the missing name (Harper checks the allowlist
	// first).
	try {
		const child = spawn(PROBE_COMMAND, []);
		// Enforcement is off, so this is a real child; keep its async ENOENT-style
		// 'error' from killing the thread and let the test report the failure.
		child.on("error", () => {});
		child.unref();
		record({ probe: "no-name", threw: false });
	} catch (error) {
		record({
			probe: "no-name",
			threw: true,
			error: String(error?.message ?? error),
		});
	}

	// Not awaited at top level, mirroring example/resources.js: the promise is
	// held and reported instead, and startDatadogAgents() never rejects.
	startDatadogAgents(import.meta.dirname).then((status) => {
		record({ probe: "status", status });
		record({ probe: "done", threw: false });
	});
}
