#!/usr/bin/env node

// Gates a release on the packed tarball, not the working tree: a broken binaries.js copy has shipped
// a package with no trace-agent in it before, and it looked correct from inside the working tree.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platformPackageDir } from "./paths.js";
import { TARGETS } from "../agent-build/toolchain.js";
import { binaryFilename, recordedBuildTags } from "../agent-build/binaries.js";
import { allPackages } from "../agent-build/packages.js";
import { EBPF_SHIP_DIR } from "../agent-build/release.js";

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

// Checked against the packed listing, not the build tree the binary was copied from: this is the
// regression test for the entire project, so it has to see exactly what a customer's install sees.
function verifyPlatformPackage(pkg) {
	const { target, dirName } = pkg;
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

	// Only what this package carries. The base package must not fail for having no system-probe in it,
	// and the probe package must still fail when it does not.
	for (const binary of pkg.binaries) {
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

	// system-probe with no objects beside it is the shape of a shipped feature that does nothing: the
	// binary starts, answers `version`, and loads not one program. Checked against the packed listing for
	// the same reason as the binaries, since `files` is what decides whether a staged directory is published.
	if (pkg.ebpf) {
		const objects = shipped.filter(
			(p) => p.startsWith(`${EBPF_SHIP_DIR}/`) && p.endsWith(".o")
		);
		if (objects.length === 0) {
			failures.push(
				`${dirName}: ships system-probe and not one eBPF object under ${EBPF_SHIP_DIR}/ - ` +
					"the binary would start and load nothing"
			);
		}
	}
}

// The package list drives this, not readdirSync(npm/): a directory listing never mentions a package whose
// npm/<name>/ was never created, which is exactly the gap this gate exists to catch.
for (const pkg of allPackages(TARGETS)) verifyPlatformPackage(pkg);

if (failures.length > 0) {
	for (const message of failures) console.error(`Publish gate: ${message}`);
	process.exit(1);
}
console.log(
	"Publish gate: every platform binary verified in the packed tarball."
);
