// Whether the release workflow builds is a runner's answer, not this file's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../support/repo.js";

const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const WORKFLOW = readFileSync(join(WORKFLOW_DIR, "build-release.yml"), "utf8");
const matches = (pattern) => [...WORKFLOW.matchAll(pattern)].length;

/** Every `run:` block body in `text`, keyed by nothing but its own indentation. */
function scriptBodies(text) {
	const bodies = [];
	let indent = null;
	for (const line of text.split("\n")) {
		if (indent !== null) {
			const width = line.search(/\S/);
			if (width === -1 || width > indent) {
				bodies[bodies.length - 1].push(line);
				continue;
			}
			indent = null;
		}
		const opened = /^(\s*)run:\s*[|>]/.exec(line);
		if (opened) {
			indent = opened[1].length;
			bodies.push([]);
		}
	}
	return bodies.map((lines) => lines.join("\n"));
}

// `7.0.0 ; touch pwned ; #` as a dispatch input is shell source once it is spliced through ${{ }}, and the
// step output carries the same string back out, so both have to arrive as an env value.
test("no attacker-controlled value is spliced into a workflow script body", () => {
	const bodies = readdirSync(WORKFLOW_DIR).flatMap((file) =>
		scriptBodies(readFileSync(join(WORKFLOW_DIR, file), "utf8"))
	);
	assert.ok(
		bodies.length > 3,
		"found almost no run: blocks; the workflow shape changed and this check is blind"
	);
	// ref_name belongs here too: git permits ; $() ` && and | in a tag name, so a tag is
	// attacker-controlled text wherever a run body interpolates it.
	const spliced = bodies.filter((body) =>
		/\$\{\{[^}]*(github\.event\.inputs|steps\.\w+\.outputs|github\.ref_name)/.test(
			body
		)
	);
	assert.deepEqual(spliced, []);

	assert.match(
		WORKFLOW,
		/DATADOG_VERSION: \$\{\{ github\.event\.inputs\.datadog_version \}\}/
	);
	assert.match(WORKFLOW, /REF_NAME: \$\{\{ github\.ref_name \}\}/);
});

// bash is on windows-latest too, so one step covers every leg. Two spellings of one job drift, which is how
// the Unix leg came to list the bin directory and the Windows leg did not.
test("version extraction and the build are each written once, not once per runner OS", () => {
	assert.equal(matches(/^\s+- name: Extract version from tag$/gm), 1);
	assert.equal(matches(/^\s+- name: Build \$\{\{ matrix\.platform \}\}$/gm), 1);
	assert.equal(matches(/^\s+id: extract_version$/gm), 1);
	assert.equal(matches(/shell: pwsh$/gm), 0);
});

// The tag's version is the package version and reaches only the publish job.
test("publish consumes prepare's version; the build never sees it", () => {
	const build = WORKFLOW.slice(
		WORKFLOW.indexOf("- name: Build ${{ matrix.platform }}"),
		WORKFLOW.indexOf("- name: Smoke test")
	);
	assert.ok(build.length > 0, "the build step was not found");
	assert.doesNotMatch(build, /needs\.prepare|github\.ref/);
	assert.match(build, /--datadog-version "\$DATADOG_VERSION"/);
	assert.match(
		WORKFLOW,
		/version: \$\{\{ needs\.prepare\.outputs\.version \}\}/
	);
});

// The org refuses a workflow that names an action by tag, and the refusal lands at job setup, so every leg dies
// before it runs anything. A tag is also mutable; a SHA is what was reviewed.
test("every action is pinned to a commit SHA", () => {
	const unpinned = [];
	for (const file of readdirSync(WORKFLOW_DIR)) {
		const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
		for (const [, ref] of text.matchAll(/uses:\s*(\S+)/g)) {
			if (ref.includes("/.github/workflows/")) continue;
			if (!/@[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$/.test(ref))
				unpinned.push(`${file}: ${ref}`);
		}
	}
	assert.deepEqual(unpinned, []);
});

// Publishing is the kit's, and the one thing the caller still passes is the target list. It has to be the
// same list binary-kit.config.js declares, or the matrix builds one set and the release publishes another.
test("the publish job calls the kit and passes the targets the config declares", async () => {
	const { default: config } = await import("../../binary-kit.config.js");
	assert.match(
		WORKFLOW,
		/uses: deliciousmonster\/harper-binary-kit\/\.github\/workflows\/release\.yml@/,
		"the release no longer calls the kit, so the publish shape is back in this repo"
	);
	const passed = /targets: '(\[[^']*\])'/.exec(WORKFLOW)?.[1];
	assert.ok(passed, `the publish job passes no target list: ${WORKFLOW}`);
	assert.deepEqual(JSON.parse(passed).sort(), [...config.targets].sort());
});

// The artifacts the build uploads are what the kit's release workflow downloads. Named differently, the
// staging finds no build tree and refuses every package, which is a whole release cycle to discover.
test("the artifact names are the ones the kit reads back", () => {
	assert.match(WORKFLOW, /name: bin-\$\{\{ matrix\.platform \}\}/);
	assert.match(WORKFLOW, /name: share-\$\{\{ matrix\.platform \}\}/);
});
