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
const { BINARIES, binariesFor } = require(
	path.join(REPO_ROOT, "dist", "src", "binaries.js")
);
const { packagesFor } = require(
	path.join(REPO_ROOT, "dist", "src", "packages.js")
);
const { EBPF_SHIP_DIR } = require(
	path.join(REPO_ROOT, "dist", "src", "release.js")
);

// The tree shape every fixture built from this repo's compiled output needs: a scripts/ dir plus the whole
// of dist/src, since a caller's copied script resolves its ../dist/src imports relative to itself. Copied
// wholesale rather than named table by table, so a script that starts importing one more never breaks here.
function scaffoldWorkDir(prefix) {
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(workDir, "scripts"));
	fs.cpSync(
		path.join(REPO_ROOT, "dist", "src"),
		path.join(workDir, "dist", "src"),
		{ recursive: true }
	);
	return workDir;
}

// Runs the real generator in a throwaway copy, over real files on disk. `args` selects the mode,
// so a caller can exercise the single-platform default as well as --all.
function generatePackages({ prefix, args = [] }) {
	const workDir = scaffoldWorkDir(prefix);

	// create-platform-packages.js imports REPO_ROOT/readRepoVersion/platformPackageDir from
	// paths.js; the copied script resolves that import relative to itself.
	for (const script of ["create-platform-packages.js", "paths.js"]) {
		fs.copyFileSync(
			path.join(REPO_ROOT, "scripts", script),
			path.join(workDir, "scripts", script)
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
		// binariesFor, not BINARIES: the generator copies only what this system has, so a fixture that laid
		// down a Linux-only binary on macOS would leave an orphan the packaging step never claims.
		for (const binary of binariesFor(target)) {
			fs.writeFileSync(
				path.join(binDir, `${binary.shipsAs}${target.exe}`),
				`#!/bin/sh\necho ${binary.shipsAs}\n`
			);
		}
		// The extraction step's other output. A build tree with system-probe and no objects beside it is a
		// state the packaging step is supposed to refuse, so the fixture for the happy path lays them down.
		if (packagesFor(target).some((pkg) => pkg.ebpf)) {
			const ebpfDir = path.join(workDir, "build", target.name, EBPF_SHIP_DIR);
			fs.mkdirSync(path.join(ebpfDir, "ebpf"), { recursive: true });
			fs.writeFileSync(path.join(ebpfDir, "ebpf", "tracer.o"), "\0not-an-elf");
		}
	}

	execFileSync(
		process.execPath,
		[path.join(workDir, "scripts", "create-platform-packages.js"), ...args],
		{ stdio: process.env.DDAB_GEN_DEBUG ? "inherit" : "ignore" }
	);
	return { workDir, npmDir: path.join(workDir, "npm") };
}

export {
	REPO_ROOT,
	scaffoldWorkDir,
	generatePackages,
	TARGETS,
	BINARIES,
	binariesFor,
	packagesFor,
	currentTarget,
};
