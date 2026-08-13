import * as path from "path";

/**
 * Single source of truth for this package's npm identity.
 *
 * Every other name is derived from `package.json`'s `name`: the platform sub-packages,
 * the strings in diagnostics, the generated platform `package.json`/README, and the
 * install instructions. Re-scoping the project (publishing under a different org, or
 * renaming the package) is therefore a one-line edit to `package.json` rather than a
 * find-and-replace across a dozen files that will inevitably miss one.
 *
 * The name was hardcoded in eleven places before this module existed. A missed
 * occurrence produces a package that resolves nothing at runtime and reports the wrong
 * package to install, which is a slow failure to diagnose.
 */

interface PackageJson {
	name?: string;
	version?: string;
}

/**
 * Walk up from this module looking for the manifest.
 *
 * Normally `dist/../package.json` resolves on the first step. The walk exists because
 * this module must not throw at import time in layouts where it does not: a bundler
 * that flattens `dist/`, or a test that copies `dist/` somewhere in isolation. Failing
 * to read a name is worth a clear error at the point of use, not an unloadable module.
 */
function readPackageJson(): PackageJson {
	let dir = __dirname;
	for (let depth = 0; depth < 5; depth++) {
		try {
			const candidate = require(path.join(dir, "package.json")) as PackageJson;
			if (candidate?.name) return candidate;
		} catch {
			// no manifest at this level; keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

const pkg = readPackageJson();

/**
 * Full package name, e.g. `@deliciousmonster/datadog-agent-binary`.
 *
 * Falls back to the published name if no manifest was found, so diagnostics stay
 * readable in an unusual layout rather than printing `undefined-linux-x86_64`.
 */
export const PACKAGE_NAME: string =
	pkg.name ?? "@deliciousmonster/datadog-agent-binary";

/** npm scope including the leading `@`, or an empty string for an unscoped package. */
export const PACKAGE_SCOPE: string = PACKAGE_NAME.startsWith("@")
	? PACKAGE_NAME.split("/")[0]
	: "";

/** This package's own version, used to version-lock the platform sub-packages. */
export const PACKAGE_VERSION: string = pkg.version ?? "0.0.0";

/**
 * Name of the platform sub-package carrying the binaries for `platformName`
 * (e.g. `linux-x86_64`).
 *
 * The suffix convention is `<package name>-<platform>`, which is what the publish
 * pipeline generates, so resolution and packaging cannot disagree about it.
 */
export function platformPackageName(platformName: string): string {
	return `${PACKAGE_NAME}-${platformName}`;
}
