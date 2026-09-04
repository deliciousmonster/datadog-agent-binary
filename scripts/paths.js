// Path formulas shared by create-platform-packages.js, verify-package.js, and
// update-optional-deps.js, so the repo-root and platform-package layout each has one owner.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..");

/** Reads the repo's root package.json and returns its version field. */
export function readRepoVersion() {
	const packageJson = JSON.parse(
		readFileSync(join(REPO_ROOT, "package.json"), "utf8")
	);
	return packageJson.version;
}

/** Directory a given platform's npm package is written to and packed from. */
export function platformPackageDir(name) {
	return join(REPO_ROOT, "npm", name);
}
