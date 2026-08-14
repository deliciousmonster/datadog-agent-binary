import * as path from "path";

/**
 * Single source of truth for this package's npm identity.
 *
 * Every other name derives from `package.json`'s `name`: platform sub-packages,
 * diagnostics, the generated platform manifests and READMEs, install instructions. The
 * name was hardcoded in eleven places before this module; a missed occurrence produces
 * a package that resolves nothing at runtime and names the wrong package to install.
 */

interface PackageJson {
	name?: string;
	version?: string;
}

/**
 * Walk up from this module looking for the manifest. `dist/../package.json` resolves on
 * the first step normally; the walk keeps import time non-throwing in layouts where it
 * does not, such as a bundler that flattens `dist/` or a test that copies `dist/` in
 * isolation.
 */
function readPackageJson(): PackageJson {
	let dir = __dirname;
	for (let depth = 0; depth < 5; depth++) {
		try {
			const candidate = require(path.join(dir, "package.json")) as PackageJson;
			if (candidate?.name) return candidate;
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

const pkg = readPackageJson();

/**
 * Full package name, e.g. `@deliciousmonster/datadog-agent-binary`. Falls back to the
 * published name when no manifest was found, so an unusual layout does not put
 * `undefined-linux-x86_64` in a diagnostic.
 */
export const PACKAGE_NAME: string =
	pkg.name ?? "@deliciousmonster/datadog-agent-binary";

/** This package's own version, used to version-lock the platform sub-packages. */
export const PACKAGE_VERSION: string = pkg.version ?? "0.0.0";

/**
 * Name of the platform sub-package carrying the binaries for `platformName` (e.g.
 * `linux-x86_64`). The `<package name>-<platform>` convention is what the publish
 * pipeline generates, so resolution and packaging cannot disagree about it.
 */
export function platformPackageName(platformName: string): string {
	return `${PACKAGE_NAME}-${platformName}`;
}
