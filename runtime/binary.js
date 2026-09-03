// The one binary resolver. The component and the bin shim take the same path, so a resolution the component
// refuses cannot still be launched by the shim.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Constant, never derived: a deployed component's nearest package.json can carry any name, and a wrong base
// resolves a platform package that does not exist.
export const PACKAGE_NAME = "@harperfast/datadog-agent-binary";

const EXE = process.platform === "win32" ? ".exe" : "";

// The package root, one level up: a dev checkout's build output sits beside runtime/, never inside it.
const PACKAGE_ROOT = join(import.meta.dirname, "..");

/** This package's platform label for the running host; throws where no platform package exists. */
function platformName() {
	const os = { linux: "linux", darwin: "macos", win32: "windows" }[
		process.platform
	];
	const arch = { x64: "x86_64", arm64: "arm64" }[process.arch];
	if (!os || !arch) {
		throw new Error(
			`unsupported platform: ${process.platform}-${process.arch}`
		);
	}
	return `${os}-${arch}`;
}

/** The platform package's accessor first (the npm install path), then a dev checkout's build output. */
export async function resolveBinary(agent) {
	const file = `${agent.shipsAs}${EXE}`;
	const platformPackage = `${PACKAGE_NAME}-${platformName()}`;
	try {
		const pkg = await import(platformPackage);
		const getBinaryPath = pkg.getBinaryPath ?? pkg.default?.getBinaryPath;
		const resolved = getBinaryPath?.(agent.shipsAs);
		// Checked by name: a package published before the trace-agent shipped answers every request with
		// the core agent, and that path exists, so trusting it starts two core agents and no receiver.
		if (resolved && basename(resolved) === file && existsSync(resolved)) {
			return resolved;
		}
	} catch {
		// The optional dependency is not installed here; the dev-checkout path below still applies.
	}
	const local = join(PACKAGE_ROOT, "build", platformName(), "bin", file);
	if (existsSync(local)) return local;
	throw new Error(
		`no ${agent.title} binary: neither ${platformPackage} nor a local build at ${local} resolved ${file}`
	);
}
