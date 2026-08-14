"use strict";

/**
 * The published manifest must never name a module id Harper's loader claims.
 *
 * Harper v5's security/jsLoader.ts keeps a HARPER_MODULE_IDS set, and
 * packageDependsOnHarper() routes any installed package that lists one of
 * those ids in dependencies, devDependencies, or peerDependencies through
 * Harper's application loader instead of Node's. A package claimed that way
 * cannot be natively imported by component code. npm pack drops no dependency
 * key from package.json, so even a devDependencies entry ships in the tarball
 * and Harper reads it in every consumer. Wave 1 removed exactly such an entry;
 * this file is what fails when any dependency key brings one back.
 *
 * The live path is proven in test/integration/harper-import.test.ts against a
 * booted Harper; this file is the hermetic guard that runs on every npm test.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// The claim-id list and its live derivation live in one support module because
// test/integration/harper-import.test.ts scans the packed artifact against the
// same ids; a private copy here or there goes stale when harper adds one.
const {
	BASELINE_CLAIMED_IDS,
	HARPER_LOADER_PATH,
	claimedIds,
	extractClaimedIds,
} = require("../support/harper-claimed-ids.js");

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Every { key, name } pair a published manifest can use to name a dependency.
 * npm publishes package.json into the tarball without dropping any of these
 * keys, and Harper reads that installed copy. The scan covers more keys than
 * packageDependsOnHarper() merges today; scanning fewer would leave the guard
 * one upstream change behind.
 */
function dependencyNames(manifest) {
	const names = [];
	for (const key of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		for (const name of Object.keys(manifest[key] ?? {})) {
			names.push({ key, name });
		}
	}
	for (const key of ["bundleDependencies", "bundledDependencies"]) {
		if (Array.isArray(manifest[key])) {
			for (const name of manifest[key]) names.push({ key, name });
		}
	}
	return names;
}

function loaderClaimViolations(manifest, claimed) {
	return dependencyNames(manifest).filter(({ name }) => claimed.has(name));
}

test("the claim list can still be derived from the installed harper", (t) => {
	if (!fs.existsSync(HARPER_LOADER_PATH)) {
		t.skip("harper is not installed; the 5.2.1 baseline list stands in");
		return;
	}
	const live = extractClaimedIds(fs.readFileSync(HARPER_LOADER_PATH, "utf8"));
	assert.ok(
		live !== null,
		"HARPER_MODULE_IDS was not found in harper's dist/security/jsLoader.js, " +
			"so the loader moved or renamed it. Re-derive the claim list from the " +
			"new source and update extractClaimedIds(); until then this suite only " +
			"knows the 5.2.1 baseline and misses upstream additions."
	);
	// A superset of the baseline, not merely a non-empty parse: an extraction
	// that finds the constant but under-extracts (a spread or a computed member
	// inside the literal, or an earlier *_HARPER_MODULE_IDS constant matching
	// first) returns a short list while still containing "harper", and catching
	// upstream additions is this canary's one job. The lists are equal today,
	// so any shortfall is a parser regression, not a harper change.
	const missing = BASELINE_CLAIMED_IDS.filter((id) => !live.includes(id));
	assert.deepEqual(
		missing,
		[],
		`extractClaimedIds() no longer sees [${missing.join(", ")}] although the ` +
			`5.2.1 baseline ships ${missing.length === 1 ? "it" : "them"}. The ` +
			`regex is under-extracting against the installed harper's jsLoader.js ` +
			`and would silently miss upstream additions too; update ` +
			`extractClaimedIds() to parse the new source shape.`
	);
});

test("no dependency key in the published manifest names a claimed module id", () => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
	);
	assert.deepEqual(
		loaderClaimViolations(manifest, claimedIds()),
		[],
		"the published manifest names a module id Harper's loader claims. " +
			"packageDependsOnHarper() will route this package through Harper's " +
			"application loader and component code can no longer import it " +
			"natively; devDependencies count because npm ships them in the " +
			"tarball. Reach Harper tooling through a transitive dependency " +
			"(as @harperfast/integration-testing already does) instead."
	);
});

test("NEGATIVE: a claimed id is flagged in every dependency key", () => {
	// The guard above passes today because there is no violation; this proves it
	// passes for that reason and not because the scan is blind.
	for (const key of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		assert.deepEqual(
			loaderClaimViolations(
				{ name: "x", [key]: { harper: "^5.0.0" } },
				claimedIds()
			),
			[{ key, name: "harper" }],
			`a harper entry in ${key} went undetected; the manifest guard is not guarding`
		);
	}
	// Bundle arrays name packages without versions; same claim, different shape.
	assert.deepEqual(
		loaderClaimViolations(
			{ name: "x", bundleDependencies: ["@harperfast/harper"] },
			claimedIds()
		),
		[{ key: "bundleDependencies", name: "@harperfast/harper" }]
	);
});

test("NEGATIVE: a scoped claimed id from the live harper list is flagged", () => {
	// Exercises the derived set rather than the baseline: '@harperfast/harper'
	// must come through claimedIds() whichever source supplied it.
	assert.deepEqual(
		loaderClaimViolations(
			{ name: "x", peerDependencies: { "@harperfast/harper": "*" } },
			claimedIds()
		),
		[{ key: "peerDependencies", name: "@harperfast/harper" }]
	);
});
