/*
 * What runs on Windows, and what makes a run count. Split from windows-gate.mjs so both decisions are tested
 * rather than only observed on a runner.
 *
 * Coverage is inclusion by default: every suite under a GROUPS directory runs, and EXCLUDED is subtracted
 * from that listing, never an allow-list added to it.
 *
 * Shrink EXCLUDED as its entries are fixed, and add one only for a failure observed on Windows, with what
 * goes uncovered written beside it. A stale entry naming a file that is gone fails the gate.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The two directories package.json's `test` script globs. A group is one child process. */
export const GROUPS = ["test/unit", "test/system"];

/** The directory `test:binaries` globs, gated by build-release.yml's Windows leg alone: it needs the binaries that leg just built. */
export const BINARIES_GROUP = "test/binaries";

export const EXCLUDED = [
	// The fixture stands in for an agent with a `#!/bin/sh` text file, and CreateProcess refuses one that is
	// not a PE image. Uncovered on Windows: the guard's own spawn, its pid lock, and the reaper launch.
	"test/system/guard-spawn.test.js",
	"test/system/partial-logger.test.js",

	// Observed 2026-09-07: the guard restarts what the teardown kills and node --test sits until the job limit.
	// Uncovered on Windows: the equivalence property itself, though the smoke test still runs there.
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
 * Why one group's run does not count as a pass, or undefined when it does.
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
