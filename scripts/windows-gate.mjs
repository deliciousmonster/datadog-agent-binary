#!/usr/bin/env node
/*
 * The Windows test gate - `npm run test:windows`, run in CI by the windows-latest legs of
 * .github/workflows/test.yml in place of `npm test`. What it gates on, and what it leaves out, is
 * windows-gate-checks.mjs; read that file's header first.
 *
 * Two things this does that the plain `node --test` invocation in package.json's `test` cannot.
 *
 * It runs GROUPS in separate processes, so a group that takes its own process down cannot cost the run the
 * groups behind it, and each group's result still lands in the table at the end.
 *
 * It requires each group to report a non-zero test count. A renamed directory, a mangled glob, or an
 * EXCLUDED list that grew to cover everything would each leave `node --test` exiting 0 having executed
 * nothing, and a green Windows leg that covers nothing is worse than the red one it replaced, because
 * nobody goes looking. groupVerdict() is what refuses those runs.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	BINARIES_GROUP,
	EXCLUDED,
	GROUPS,
	groupVerdict,
	selectSuites,
} from "./windows-gate-checks.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// package.json's `test` script sets the same timeout, and for the same reason: node --test defaults to 0,
// so a supervision change that hangs reads as a stuck machine rather than as a failure.
const TEST_TIMEOUT_MS = 120_000;

const stale = EXCLUDED.filter((file) => !existsSync(join(REPO_ROOT, file)));
if (stale.length) {
	console.error(
		`Windows gate: EXCLUDED names ${stale.join(", ")}, which is not on disk. Delete the entry, or ` +
			"fix the path it was meant to name."
	);
	process.exit(1);
}

/** One group in its own process. TAP, not spec: the summary lines groupVerdict reads back are stable and uncoloured. */
function runGroup(files) {
	const child = spawnSync(
		process.execPath,
		[
			"--test",
			"--test-reporter=tap",
			`--test-timeout=${TEST_TIMEOUT_MS}`,
			...files,
		],
		{ cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	);
	const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
	process.stdout.write(output);
	return groupVerdict({ output, status: child.status, error: child.error });
}

// `--binaries` gates test/binaries alone, for the release leg that has just built what it reads;
// with no argument the gate is `npm test`'s two directories. Anything else is a typo, not a group.
const groups = process.argv.slice(2);
if (groups.length && !(groups.length === 1 && groups[0] === "--binaries")) {
	console.error(
		`Windows gate: unknown argument ${groups.join(" ")}; the only option is --binaries`
	);
	process.exit(1);
}
const selected = groups.length ? [BINARIES_GROUP] : GROUPS;

const results = [];
for (const group of selected) {
	const files = selectSuites(REPO_ROOT, group);
	console.log(`\n=== ${group} (${files.length} suite(s)) ===`);
	for (const file of files) console.log(`  ${file}`);
	// A group whose directory was renamed, or whose every suite ended up excluded, must not pass on nothing.
	if (files.length === 0) {
		results.push({ group, tests: 0, reason: "selected no suites" });
		continue;
	}
	results.push({ group, ...runGroup(files) });
}

console.log("\n=== Windows test gate ===");
for (const { group, tests, reason } of results) {
	const cells = [`${String(tests ?? "?").padStart(5)} tests`, group];
	console.log(
		`${reason ? "FAIL" : "ok  "}  ${cells.join("  ")}${reason ? `  - ${reason}` : ""}`
	);
}

const failed = results.filter((result) => result.reason);
if (failed.length) {
	console.error(`\n${failed.length} of ${results.length} group(s) failed.`);
	process.exitCode = 1;
} else {
	const total = results.reduce((sum, result) => sum + result.tests, 0);
	console.log(`\nAll ${results.length} groups passed (${total} tests).`);
}
