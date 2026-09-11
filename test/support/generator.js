import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const fs = require("node:fs");
const path = require("node:path");

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
