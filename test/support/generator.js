import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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
	path.join(REPO_ROOT, "dist", "src", "targets.js")
);
const { BINARIES } = require(
	path.join(REPO_ROOT, "dist", "src", "binaries.js")
);

// Runs the real generator in a throwaway copy, over real files on disk. `args` selects the mode,
// so a caller can exercise the single-platform default as well as --all.
function generatePackages({ prefix, args = [] }) {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(workDir, "scripts"));
	// The compiled tree mirrors the source tree, so the copy has to nest the same way the generator requires.
	fs.mkdirSync(path.join(workDir, "dist", "src"), { recursive: true });

	fs.copyFileSync(
		path.join(REPO_ROOT, "scripts", "create-platform-packages.js"),
		path.join(workDir, "scripts", "create-platform-packages.js")
	);
	for (const table of ["targets.js", "binaries.js"]) {
		fs.copyFileSync(
			path.join(REPO_ROOT, "dist", "src", table),
			path.join(workDir, "dist", "src", table)
		);
	}
	fs.copyFileSync(
		path.join(REPO_ROOT, "package.json"),
		path.join(workDir, "package.json")
	);

	const built = args.includes("--all") ? TARGETS : [currentTarget()];
	for (const target of built) {
		const binDir = path.join(workDir, "build", target.name, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		for (const binary of BINARIES) {
			fs.writeFileSync(
				path.join(binDir, `${binary.shipsAs}${target.exe}`),
				`#!/bin/sh\necho ${binary.shipsAs}\n`
			);
		}
	}

	execFileSync(
		process.execPath,
		[path.join(workDir, "scripts", "create-platform-packages.js"), ...args],
		{ stdio: "ignore" }
	);
	return { workDir, npmDir: path.join(workDir, "npm") };
}

export { REPO_ROOT, generatePackages, TARGETS, BINARIES, currentTarget };
