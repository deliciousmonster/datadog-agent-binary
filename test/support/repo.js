// Where this repository is, and the tables under agent-build/ that the suites read.
//
// One computation of the root, because there were four, done three different ways. A suite that walks up
// from its own directory and one that counts `..` hops disagree the moment a file moves, and the one that
// counts hops fails silently: it selects nothing and reports a group that matched no suites.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const fs = require("node:fs");
const path = require("node:path");

/** Up from `start` until a package.json, which is the root whatever depth a caller sits at. */
function findRepoRoot(start) {
	let dir = start;
	while (!fs.existsSync(path.join(dir, "package.json"))) {
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error("Could not locate package root");
		dir = parent;
	}
	return dir;
}

const REPO_ROOT = findRepoRoot(import.meta.dirname);
const { TARGETS, currentTarget } = require(
	path.join(REPO_ROOT, "agent-build", "toolchain.js")
);
const { BINARIES, binariesFor } = require(
	path.join(REPO_ROOT, "agent-build", "binaries.js")
);

export { REPO_ROOT, TARGETS, BINARIES, binariesFor, currentTarget };
