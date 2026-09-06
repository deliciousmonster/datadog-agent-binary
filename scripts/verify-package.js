#!/usr/bin/env node

// Gates a release on the packed tarball, not the working tree: `npm publish` from a clone missing
// --recurse-submodules ships an empty guard/, and a broken binaries.js copy has shipped a package
// with no trace-agent in it before. Both looked correct from inside the working tree.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, platformPackageDir } from "./paths.js";
import { TARGETS } from "../dist/src/targets.js";
import {
	BINARIES,
	binaryFilename,
	recordedBuildTags,
} from "../dist/src/binaries.js";

// Windows ships npm as npm.cmd, and node refuses to spawn a .cmd without a shell (CVE-2024-27980), so
// without this the gate dies `spawnSync npm ENOENT` there instead of reading the tarball.
const NPM_NEEDS_SHELL = process.platform === "win32";

// --ignore-scripts, because pack still runs "prepare" without it: this dry-run inspects a manifest,
// it does not consent to running whatever that package's lifecycle hooks do.
function packedPaths(dir) {
	const out = execFileSync(
		"npm",
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{ cwd: dir, encoding: "utf8", shell: NPM_NEEDS_SHELL }
	);
	return JSON.parse(out)[0].files.map((file) => file.path);
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
function verifyPlatformPackage(target) {
	const dirName = target.name;
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
		const bytes = readFileSync(join(dir, relPath));
		if (
			binary.requiredSymbol &&
			!bytes.includes(Buffer.from(binary.requiredSymbol, "latin1"))
		) {
			failures.push(
				`${dirName}/${binary.shipsAs}: required symbol "${binary.requiredSymbol}" appears 0 times in the packed binary`
			);
		}
		if (binary.forbiddenBuildTag) {
			const tags = recordedBuildTags(bytes);
			// A binary with no tag record is not a binary that dropped the tag: unreadable has to
			// refuse, or the gate passes every artifact whose build info it failed to find.
			if (tags === null) {
				failures.push(
					`${dirName}/${binary.shipsAs}: carries no Go build-tag record, so the ` +
						`"${binary.forbiddenBuildTag}" exclusion cannot be read off the packed binary`
				);
			} else if (tags.includes(binary.forbiddenBuildTag)) {
				failures.push(
					`${dirName}/${binary.shipsAs}: was compiled with the "${binary.forbiddenBuildTag}" ` +
						"build tag, which mandatoryArgs' --build-exclude is there to drop"
				);
			}
		}
	}
}

verifyGuard();

// TARGETS drives this, not readdirSync(npm/): a directory listing never mentions a target whose
// npm/<name>/ was never created, which is exactly the gap this gate exists to catch.
for (const target of TARGETS) verifyPlatformPackage(target);

if (failures.length > 0) {
	for (const message of failures) console.error(`Publish gate: ${message}`);
	process.exit(1);
}
console.log(
	"Publish gate: guard/ and every platform binary verified in the packed tarball."
);
