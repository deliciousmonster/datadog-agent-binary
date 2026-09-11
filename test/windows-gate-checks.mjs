/*
 * What runs on Windows, and what makes a run count. Split from windows-gate.mjs so both decisions can be
 * tested (test/unit/windows-gate.test.js) rather than only observed on a Windows runner.
 *
 * SCOPE. Coverage is inclusion by default: every *.test.js under a GROUPS directory runs, so a suite added
 * tomorrow is gated on Windows the day it is added without anyone opting it in. EXCLUDED is subtracted from
 * that listing; it is never an allow-list added to it. GROUPS is the same pair of directories package.json's
 * `test` script collects, so the two cannot drift into gating different trees.
 *
 * MAINTENANCE. Shrink EXCLUDED as its entries are fixed. Every entry states why it is there and what goes
 * uncovered on Windows as a result - do not add one without both, and do not add one for a suite that merely
 * looks risky, only for one observed to fail. A stale entry naming a file that no longer exists fails the
 * gate rather than sitting there excluding nothing. Confirm a fix by deleting the line and running
 * `npm run test:windows` on Windows, not by reasoning about it from another OS.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The two directories package.json's `test` script globs. A group is one child process. */
export const GROUPS = ["test/unit", "test/system"];

/** The directory `test:binaries` globs, gated by build-release.yml's Windows leg alone: it needs the binaries that leg just built. */
export const BINARIES_GROUP = "test/binaries";

export const EXCLUDED = [
	// --- The fixture agent binary cannot be an executable on Windows ------------------
	// Both files need the guard to spawn an agent for real out of build/<platform>/bin, and the fixture
	// stands in for one with a `#!/bin/sh` text file (test/support/component.js:35). On Windows that path
	// ends in `.exe` (currentTarget().exe) and CreateProcess refuses a file that is not a PE image, so
	// every case fails `spawn UNKNOWN` before it asserts anything.
	//
	// Not covered on Windows as a result: the guard's own spawn and the pid lock it takes per agent, the
	// reaper launch, the status endpoint tracking an agent that died or restarted, the refusal of a verdict
	// taken before a restart, and stopping an orphan left by an earlier configuration. The recorded-Harper
	// half of supervision - config rendering, port parsing, every verify verdict - still runs, in
	// test/system/supervisor-start.test.js.
	//
	// Unblocking these needs a fixture that writes a real Windows executable at <agent>.exe: one that
	// ignores its argv and either exits at once or stays up, per the stub bodies component.js offers. No
	// system binary does both, so it means shipping or generating a small PE for the purpose.
	"test/system/guard-spawn.test.js",
	"test/system/partial-logger.test.js",

	// --- The guard row's teardown restarts what it kills, and the runner never exits ------
	// Observed on the release run's Windows leg (2026-09-07): the native row passes; under the guard
	// row both agents verify, die together 30s later with exit code 1 when the teardown halts them,
	// the guard restarts both because nothing stopped its supervision first, and node --test then
	// sits until the job's 60-minute limit cancels it. On every other OS the same file passes.
	//
	// Not covered on Windows as a result: the equivalence property itself under the bundled guard,
	// that guardSupervisor delivers the same trace count as harperSupervisor for the same input.
	// The smoke test on the same leg still proves both binaries bind and serve there.
	//
	// Unblocking this means stopping the guard's supervision before the teardown halts its
	// processes, which is a change to how the row ends rather than to what it proves, and then
	// confirming on a Windows runner that the process exits.
	"test/binaries/supervision-equivalence.test.js",
];

/** Every *.test.js under `group`, repo-relative and slash-separated whatever separator the host walks with. */
export function suitesIn(root, group) {
	const dir = join(root, group);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true })
		.map((entry) => `${group}/${String(entry).split("\\").join("/")}`)
		.filter((file) => file.endsWith(".test.js"))
		.sort();
}

/** The suites `group` gates on: everything under it that EXCLUDED does not name. */
export const selectSuites = (root, group) =>
	suitesIn(root, group).filter((file) => !EXCLUDED.includes(file));

/**
 * Why one group's run does not count as a pass, or undefined when it does. `node --test` exits 0 when its
 * pattern matches nothing, so a run that reported no summary or ran no test has to fail here rather than
 * report a green leg that executed nothing.
 */
export function groupVerdict(
	/** @type {{ output: string, status: number | null, error?: Error }} */ {
		output,
		status,
		error,
	}
) {
	const count = (field) => {
		const found = output.match(new RegExp(`^# ${field} (\\d+)$`, "m"));
		return found ? Number(found[1]) : undefined;
	};
	const tests = count("tests");
	const failed = count("fail");

	if (error) return { tests, reason: `could not be spawned: ${error.message}` };
	if (tests === undefined)
		return {
			tests,
			reason: `exited ${status} without reporting a TAP summary`,
		};
	if (tests === 0) return { tests, reason: "executed no tests" };
	if (failed) return { tests, reason: `${failed} of ${tests} failed` };
	if (status !== 0) return { tests, reason: `exited ${status}` };
	return { tests };
}
