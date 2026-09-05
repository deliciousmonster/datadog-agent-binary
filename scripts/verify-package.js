#!/usr/bin/env node

// Gates a release on the packed tarball, not the working tree: `npm publish` from a clone missing
// --recurse-submodules ships an empty guard/, and a broken binaries.js copy has shipped a package
// with no trace-agent in it before. Both looked correct from inside the working tree.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, platformPackageDir } from "./paths.js";
import { TARGETS } from "../dist/src/targets.js";
import { BINARIES, binaryFilename } from "../dist/src/binaries.js";

// --ignore-scripts, because pack still runs "prepare" without it: this dry-run inspects a manifest,
// it does not consent to running whatever that package's lifecycle hooks do.
function packedPaths(dir) {
	const out = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{ cwd: dir, encoding: "utf8" }
	);
	return JSON.parse(out)[0].files.map((file) => file.path);
}

function countSymbol(binaryPath, symbol) {
	const bytes = readFileSync(binaryPath);
	const needle = Buffer.from(symbol, "latin1");
	let count = 0;
	for (
		let at = bytes.indexOf(needle);
		at !== -1;
		at = bytes.indexOf(needle, at + needle.length)
	) {
		count++;
	}
	return count;
}

const failures = [];

function verifyGuard() {
	const shipped = packedPaths(REPO_ROOT).filter((p) => p.startsWith("guard/"));
	if (shipped.length === 0) {
		failures.push(
			"guard/ is absent or empty in the packed tarball. Publish from a clone taken with " +
				"--recurse-submodules, or run `git submodule update --init` first."
		);
	}
}

// Checked against the packed listing, not the build tree the binary was copied from: this is the
// regression test for the entire project, so it has to see exactly what a customer's install sees.
function verifyPlatformPackage(dirName) {
	const dir = platformPackageDir(dirName);
	if (!existsSync(join(dir, "package.json"))) {
		// A throw mid-copy can leave bin/ populated with no package.json, or - when the very first
		// binary is missing - leave bin/ empty and the directory itself absent. Both used to pass silently.
		const binDir = join(dir, "bin");
		if (existsSync(binDir) && readdirSync(binDir).length > 0) {
			failures.push(
				`${dirName}: bin/ has content but no package.json - a partial build was left behind, ` +
					"re-run npm run all-platform-packages from clean"
			);
		} else {
			failures.push(
				`${dirName}: no platform package was ever created - package.json is missing and bin/ ` +
					"is empty or absent, re-run npm run all-platform-packages from clean"
			);
		}
		return;
	}

	const shipped = packedPaths(dir);
	const binFiles = shipped.filter((p) => p.startsWith("bin/"));
	if (binFiles.length === 0) {
		failures.push(`${dirName}: platform package ships zero binaries`);
		return;
	}

	const target = TARGETS.find((t) => t.name === dirName);
	if (!target) {
		failures.push(`${dirName}: no matching entry in src/targets.ts`);
		return;
	}

	// npm filters optionalDependencies on process.platform and process.arch, so a wrong os or cpu is
	// never an install error: npm skips the package, exits 0, and leaves the host with no agent.
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	for (const [field, want] of [
		["os", target.npmOs],
		["cpu", target.npmCpu],
	]) {
		// The absence check cannot be folded into the comparison: a dist compiled before these fields
		// moved onto Target leaves both sides undefined, and a null that agrees with a null still ships.
		if (!want) {
			failures.push(
				`${dirName}: src/targets.ts carries no npm ${field} for this target, so nothing can be ` +
					"verified against - dist/ is stale, rebuild it with npm run build"
			);
		} else if (JSON.stringify(manifest[field]) !== JSON.stringify([want])) {
			failures.push(
				`${dirName}: package.json ${field} is ${JSON.stringify(manifest[field])}, must be ` +
					`["${want}"] - npm would skip this package on every host, in silence`
			);
		}
	}

	for (const binary of BINARIES) {
		const relPath = `bin/${binaryFilename(binary, target)}`;
		if (!binFiles.includes(relPath)) {
			failures.push(
				`${dirName}: ${binary.shipsAs} is missing from the packed tarball`
			);
			continue;
		}
		const binaryPath = join(dir, relPath);
		if (
			binary.requiredSymbol &&
			countSymbol(binaryPath, binary.requiredSymbol) === 0
		) {
			failures.push(
				`${dirName}/${binary.shipsAs}: required symbol "${binary.requiredSymbol}" appears 0 times in the packed binary`
			);
		}
		if (
			binary.forbiddenSymbol &&
			countSymbol(binaryPath, binary.forbiddenSymbol) > 0
		) {
			failures.push(
				`${dirName}/${binary.shipsAs}: forbidden symbol "${binary.forbiddenSymbol}" is present in the packed binary`
			);
		}
	}
}

verifyGuard();
const npmDir = join(REPO_ROOT, "npm");

// TARGETS drives this, not readdirSync(npmDir): a directory listing never mentions a target whose
// npm/<name>/ was never created, which is exactly the gap this gate exists to catch.
for (const target of TARGETS) verifyPlatformPackage(target.name);

// Anything left under npm/ that no target names still ships - the publish step iterates npm/*/, not
// TARGETS - so it gets the same scrutiny, via the "no matching entry in src/targets.ts" check above.
const knownNames = new Set(TARGETS.map((target) => target.name));
if (existsSync(npmDir)) {
	for (const dirName of readdirSync(npmDir)) {
		if (!knownNames.has(dirName)) verifyPlatformPackage(dirName);
	}
}

if (failures.length > 0) {
	for (const message of failures) console.error(`Publish gate: ${message}`);
	process.exit(1);
}
console.log(
	"Publish gate: guard/ and every platform binary verified in the packed tarball."
);
