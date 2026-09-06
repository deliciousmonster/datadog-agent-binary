// The Windows gate decides what a windows-latest leg covers. A gate that selected nothing, or that counted
// a run of zero tests as a pass, would report green while covering nothing - so both decisions are asserted
// here, on every platform, rather than only observed on a Windows runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	EXCLUDED,
	GROUPS,
	groupVerdict,
	selectSuites,
	suitesIn,
} from "../../scripts/windows-gate-checks.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const summary = ({ tests = 1, fail = 0 }) =>
	`1..${tests}\n# tests ${tests}\n# pass ${tests - fail}\n# fail ${fail}\n`;

const TEST_WORKFLOW = fs.readFileSync(
	path.join(REPO_ROOT, ".github", "workflows", "test.yml"),
	"utf8"
);

/** A root holding `files`, each an empty suite, for a selection test that must not write into the repo. */
function withPlantedRoot(files, run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ddab-windows-gate-"));
	try {
		for (const file of files) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), "");
		}
		return run(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("every excluded suite is a file that exists, so the list cannot rot into excluding nothing", () => {
	for (const file of EXCLUDED) {
		assert.ok(
			fs.existsSync(path.join(REPO_ROOT, file)),
			`EXCLUDED names ${file}, which is not on disk; delete the entry or fix the path`
		);
	}
});

test("coverage is inclusion by default: every suite under a group runs unless EXCLUDED names it", () => {
	for (const group of GROUPS) {
		const all = suitesIn(REPO_ROOT, group);
		assert.ok(all.length > 0, `${group} holds no *.test.js at all`);
		assert.deepEqual(
			selectSuites(REPO_ROOT, group),
			all.filter((file) => !EXCLUDED.includes(file)),
			`${group} is gated on something other than "everything but EXCLUDED", which is an allow-list`
		);
	}
});

test("a suite added under a group is selected, nested or not, with nothing to opt it in", () => {
	const group = GROUPS[0];
	const added = [`${group}/added.test.js`, `${group}/nested/deeper.test.js`];
	const excludedHere = EXCLUDED.filter((file) => file.startsWith(`${group}/`));
	withPlantedRoot([...added, `${group}/helper.js`, ...excludedHere], (root) => {
		assert.deepEqual(
			selectSuites(root, group),
			added,
			"a new suite has to be gated on Windows the day it is added, and only EXCLUDED may take one out"
		);
	});
});

test("NEGATIVE: a run that executed nothing is refused rather than counted as a pass", () => {
	// `node --test` exits 0 on a pattern that matched nothing, which is the shape of a green-but-empty leg.
	assert.match(
		groupVerdict({ output: summary({ tests: 0 }), status: 0 }).reason,
		/executed no tests/
	);
});

test("NEGATIVE: a run that reported no summary is refused, whatever it exited", () => {
	// A process killed mid-run, or one whose reporter never got to write, drains without an epilogue.
	assert.match(
		groupVerdict({ output: "some output, no epilogue\n", status: 0 }).reason,
		/without reporting a TAP summary/
	);
	assert.match(
		groupVerdict({
			output: "",
			status: null,
			error: new Error("spawn ENOENT"),
		}).reason,
		/could not be spawned/
	);
});

test("a failed test and a non-zero exit each fail the group, and a clean run passes", () => {
	assert.match(
		groupVerdict({ output: summary({ tests: 9, fail: 2 }), status: 1 }).reason,
		/2 of 9 failed/
	);
	// Exit code alone: every assertion passed and the process still died, which is what node reports for
	// an unhandled rejection raised after the epilogue.
	assert.match(
		groupVerdict({ output: summary({ tests: 9 }), status: 7 }).reason,
		/exited 7/
	);
	assert.deepEqual(groupVerdict({ output: summary({ tests: 9 }), status: 0 }), {
		tests: 9,
	});
});

test("CI runs the gate on the Windows legs and npm test on the rest, with neither allowed to fail softly", () => {
	assert.match(
		TEST_WORKFLOW,
		/os: \[ubuntu-latest, macos-latest, windows-latest\]/,
		"the matrix has to still carry windows-latest for any of this to run"
	);
	assert.match(
		TEST_WORKFLOW,
		/if: runner\.os == 'Windows'\n\s+run: npm run test:windows/,
		"the Windows legs have to run the gate; npm test there is the red run this replaced"
	);
	assert.match(
		TEST_WORKFLOW,
		/if: runner\.os != 'Windows'\n\s+run: npm test/,
		"the other legs have to run the whole suite, unfiltered by EXCLUDED"
	);
	// A leg that reports success on a failed step is a required check that checks nothing.
	assert.doesNotMatch(TEST_WORKFLOW, /continue-on-error/);
});

test("CI fails a run whose glob matched no suite, which node --test alone reports as a pass", () => {
	assert.match(
		TEST_WORKFLOW,
		/find test\/component test\/e2e -type f -name '\*\.test\.js'/,
		"the empty-glob guard has to count the same directories the test step runs"
	);
	assert.match(
		TEST_WORKFLOW,
		/if \[ "\$count" -eq 0 \]; then\n\s+echo "::error/
	);
});
