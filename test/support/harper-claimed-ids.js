"use strict";

/**
 * Single source of the module ids Harper's loader claims.
 *
 * Harper v5's security/jsLoader.ts keeps a HARPER_MODULE_IDS set, and
 * packageDependsOnHarper() routes any installed package that lists one of
 * those ids in a dependency key through Harper's application loader instead of
 * Node's, which breaks native imports of the package. The constant is
 * module-private and harper's exports map exposes only the package entry, so
 * it cannot be imported; BASELINE_CLAIMED_IDS is the floor as shipped in
 * harper 5.2.1, and claimedIds() unions in whatever the installed harper
 * ships so an upstream addition is still caught.
 *
 * Shared by test/unit/harper-loader-claim.test.js (scans the repo manifest)
 * and test/integration/harper-import.test.ts (scans the packed artifact). A
 * private copy in either consumer would freeze at the 5.2.1 baseline and go
 * stale silently when harper adds an id.
 */

const fs = require("node:fs");
const path = require("node:path");

const BASELINE_CLAIMED_IDS = [
	"harper",
	"harperdb",
	"harperdb/v1",
	"harperdb/v2",
	"@harperfast/harper",
	"@harperfast/harper-pro",
];

const HARPER_LOADER_PATH = path.join(
	__dirname,
	"..",
	"..",
	"node_modules",
	"harper",
	"dist",
	"security",
	"jsLoader.js"
);

/** The string literals of `HARPER_MODULE_IDS = new Set([...])`, or null. */
function extractClaimedIds(source) {
	const block = source.match(/HARPER_MODULE_IDS\s*=\s*new Set\(\[([^\]]*)\]/);
	if (!block) return null;
	return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** The baseline unioned with the installed harper's live list, as a Set. */
function claimedIds() {
	const ids = new Set(BASELINE_CLAIMED_IDS);
	if (fs.existsSync(HARPER_LOADER_PATH)) {
		const live = extractClaimedIds(fs.readFileSync(HARPER_LOADER_PATH, "utf8"));
		for (const id of live ?? []) ids.add(id);
	}
	return ids;
}

module.exports = {
	BASELINE_CLAIMED_IDS,
	HARPER_LOADER_PATH,
	claimedIds,
	extractClaimedIds,
};
