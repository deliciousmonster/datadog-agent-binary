import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Whether the release workflow builds is a runner's answer, not this file's. What is checkable here
// is the shape: one step per job rather than a Unix and a pwsh copy, and no input reaching a script.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("../support/generator.js");

const WORKFLOW_DIR = path.join(REPO_ROOT, ".github", "workflows");

const WORKFLOW = fs.readFileSync(
	path.join(REPO_ROOT, ".github", "workflows", "build-release.yml"),
	"utf8"
);

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

// `7.0.0 ; touch pwned ; #` as a dispatch input is shell source once it is spliced through ${{ }},
// and the step output carries the same string back out, so both have to arrive as an env value.
test("no attacker-controlled value is spliced into a workflow script body", () => {
	const bodies = fs
		.readdirSync(WORKFLOW_DIR)
		.flatMap((file) =>
			scriptBodies(fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8"))
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
	assert.match(
		WORKFLOW,
		/VERSION: \$\{\{ needs\.prepare\.outputs\.version \}\}/
	);
	assert.match(WORKFLOW, /REF_NAME: \$\{\{ github\.ref_name \}\}/);
});

// bash is on windows-latest too, so one step covers every leg. Two spellings of one job drift, which
// is how the Unix leg came to list the bin directory and the Windows leg did not.
test("version extraction and the build are each written once, not once per runner OS", () => {
	assert.equal(matches(/^\s+- name: Extract version from tag$/gm), 1);
	assert.equal(matches(/^\s+- name: Build \$\{\{ matrix\.platform \}\}$/gm), 1);
	assert.equal(matches(/^\s+id: extract_version$/gm), 1);
	assert.equal(matches(/shell: pwsh$/gm), 0);
});

// The tag's version is the package version and reaches only `npm version` in publish. The build reads
// .datadog-agent-version unless a dispatch names a Datadog version outright: the two numbers share a
// core and nothing else, and a tag of 7.82.1-next.0 once asked Datadog's repository for that branch.
test("publish consumes prepare's version; the build never sees it", () => {
	assert.equal(
		matches(/VERSION: \$\{\{ needs\.prepare\.outputs\.version \}\}/g),
		1
	);
	const build = WORKFLOW.slice(
		WORKFLOW.indexOf("- name: Build ${{ matrix.platform }}"),
		WORKFLOW.indexOf("- name: Smoke test")
	);
	assert.ok(build.length > 0, "the build step was not found");
	assert.doesNotMatch(build, /needs\.prepare|github\.ref/);
	assert.match(build, /--datadog-version "\$DATADOG_VERSION"/);
});

// The org refuses a workflow that names an action by tag, and the refusal lands at job setup, so
// every leg dies before it runs anything. A tag is also mutable; a SHA is what was reviewed.
test("every action is pinned to a commit SHA", () => {
	const unpinned = [];
	for (const file of fs.readdirSync(WORKFLOW_DIR)) {
		const text = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
		for (const [, ref] of text.matchAll(/uses:\s*(\S+)/g)) {
			if (!/@[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$/.test(ref))
				unpinned.push(`${file}: ${ref}`);
		}
	}
	assert.deepEqual(unpinned, []);
});

// A release that publishes four packages, fails on the fifth, and never attempts the last four is
// worse than one that fails outright: half the names are at the new version, half at the old, and
// the run says nothing about whether the untried ones would have worked. That happened on
// 2026-09-11, and it cost a whole build cycle per missing trusted publisher to discover them one at
// a time. npm answers a publish to a name with no trusted publisher with 404 rather than 403, so
// "not configured" and "not there" look identical and every name has to be tried to be known.
test("the platform publish loop attempts every package before it fails", () => {
	const loop = scriptBodies(WORKFLOW).find((body) =>
		body.includes("npm publish --access public --tag")
	);
	assert.ok(loop, "no platform publish loop in the workflow");

	// The defect exactly: a bare `npm publish` inside a `bash -e` loop aborts the iteration.
	assert.ok(
		!/^\s*npm publish --access public --tag "\$DIST_TAG"\s*$/m.test(loop),
		"an unguarded npm publish inside the loop aborts at the first failure"
	);
	assert.match(
		loop,
		/if npm publish --access public --tag "\$DIST_TAG"; then/,
		"the publish has to be tested rather than run bare, or bash -e ends the loop"
	);
});

// Attempting everything is only half of it: a run that swallowed the failures would report success
// on a half-published release, which is worse again.
test("NEGATIVE: a failed publish still fails the step, naming what did not publish", () => {
	const loop = scriptBodies(WORKFLOW).find((body) =>
		body.includes("npm publish --access public --tag")
	);
	assert.match(loop, /failed\+=\("\$platform"\)/, "failures are not collected");
	assert.match(
		loop,
		/if \[ \$\{#failed\[@\]\} -gt 0 \]; then[\s\S]*exit 1/,
		"collected failures never fail the step"
	);
	assert.match(
		loop,
		/\$\{failed\[\*\]\}/,
		"the failure does not name which packages did not publish"
	);
});

// The main package carries optionalDependencies pinned to the platform versions, so publishing it
// after a partial platform publish points it at versions that do not exist.
test("the main package publishes only after every platform package did", () => {
	const platformAt = WORKFLOW.indexOf("- name: Publish platform packages");
	const mainAt = WORKFLOW.indexOf("- name: Publish main package");
	assert.ok(platformAt !== -1 && mainAt !== -1);
	assert.ok(
		platformAt < mainAt,
		"the main package is published before the platform packages it depends on"
	);
});

// npm assigns `latest` only on a package's first publish, and every release here goes out under `next`.
// On 2026-09-11 all ten packages served 7.82.1-next.9 under `next` and 7.82.1-next.6 under `latest`,
// three releases behind, which is the version npmjs.com displays and a bare `npm install` resolves.
test("the release moves latest to the version it just published", () => {
	const step = scriptBodies(WORKFLOW).find((body) =>
		body.includes("npm dist-tag add")
	);
	assert.ok(step, "nothing in the release moves the latest dist-tag");
	assert.match(
		step,
		/npm dist-tag add "\$name@\$version" latest/,
		"the tag is moved to something other than the published version"
	);
	// Every package, not just the main one: a main package on latest whose platform packages are not
	// resolves to optionalDependencies nobody can install.
	assert.match(
		step,
		/for platform_dir in npm\/\*\//,
		"only the main package's latest is moved"
	);
});

// A re-run of an older tag must not walk latest backwards onto a version it already passed.
test("NEGATIVE: latest only ever moves forward", () => {
	const step = scriptBodies(WORKFLOW).find((body) =>
		body.includes("npm dist-tag add")
	);
	assert.match(
		step,
		/sort -rV/,
		"nothing compares the published version against the current latest"
	);
	assert.match(
		step,
		/Leaving \$name at latest=/,
		"a newer latest is not left alone"
	);
});

// Publishing succeeded and the tag move did not is a real state, and it has to be visible: the step
// prints the exact commands rather than leaving latest silently stale for another release.
test("a failed tag move fails the step and names the commands to run", () => {
	const step = scriptBodies(WORKFLOW).find((body) =>
		body.includes("npm dist-tag add")
	);
	assert.match(step, /failed\+=\("\$name"\)/, "failures are not collected");
	assert.match(step, /exit 1/, "a failed tag move does not fail the step");
	assert.match(
		step,
		/echo " {2}npm dist-tag add \$name@\$version latest"/,
		"the failure does not print the command to run by hand"
	);
});
