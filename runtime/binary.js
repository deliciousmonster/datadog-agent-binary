// The one binary resolver: the installed platform packages first, then a dev checkout's build output.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

// Constant, never derived: a deployed component's nearest package.json can carry any name, and a wrong base
// resolves a platform package that does not exist.
export const PACKAGE_NAME = "@deliciousmonster/datadog-agent-binary";

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

/**
 * The two packages that can carry a binary, in the order they are asked.
 *
 * The base package is an optionalDependency and is there on every install. The probe package is not: it
 * carries system-probe, security-agent and 42 MB of eBPF objects, and an operator installs it by name when
 * they want them. Both are asked for every binary rather than routed by name, so a binary that moves
 * between the two does not need this file changed, and so the error can say which package was absent.
 */
const packagesFor = (platform) => [
	{ name: `${PACKAGE_NAME}-${platform}`, optional: false },
	{ name: `${PACKAGE_NAME}-probe-${platform}`, optional: true },
];

/** What asking one platform package for one binary produced. */
async function ask(packageName, shipsAs, file) {
	let pkg;
	try {
		pkg = await import(packageName);
	} catch {
		return { installed: false };
	}
	const getBinaryPath = pkg.getBinaryPath ?? pkg.default?.getBinaryPath;
	let resolved;
	try {
		resolved = getBinaryPath?.(shipsAs);
	} catch {
		// getBinaryPath throws on a name it does not carry, which is the ordinary answer from the base
		// package when asked for system-probe. It is installed and does not have this one.
		return { installed: true };
	}
	// Checked by name: a package published before the trace-agent shipped answers every request with the
	// core agent, and that path exists, so trusting it starts two core agents and no receiver.
	if (resolved && basename(resolved) === file && existsSync(resolved))
		return { installed: true, path: resolved };
	// Set only on a name mismatch, so the error below can tell "the package answered with the wrong
	// binary" apart from "the package isn't installed" instead of collapsing both into one guess.
	return { installed: true, staleMatch: resolved };
}

/** The platform packages' accessors first (the npm install path), then a dev checkout's build output. */
export async function resolveBinary(agent) {
	const file = `${agent.shipsAs}${EXE}`;
	const platform = platformName();
	const candidates = packagesFor(platform);

	const asked = [];
	for (const candidate of candidates) {
		const answer = await ask(candidate.name, agent.shipsAs, file);
		if (answer.path) return answer.path;
		asked.push({ ...candidate, ...answer });
	}

	const local = join(PACKAGE_ROOT, "build", platform, "bin", file);
	if (existsSync(local)) return local;

	throw new Error(
		`no ${agent.title} binary: ${resolutionFailure(asked, file, local)}`
	);
}

/**
 * Why nothing resolved, distinguishing the three states a package can be in.
 *
 * These want different things from the reader. A missing optional package is a choice they made and the fix
 * is to install it. An installed package that answered with the wrong file is a version that predates the
 * binary and the fix is an upgrade. An absent base package is a broken install.
 */
export function resolutionFailure(asked, file, local) {
	const stale = asked.find((a) => a.staleMatch);
	if (stale)
		return (
			`${stale.name} is installed but predates ${file} support (it resolved ${stale.staleMatch} ` +
			`instead) and no local build exists at ${local}. Update ${stale.name} to a version that ships ` +
			`${file}, or build locally with npm run build-agent.`
		);

	const missingOptional = asked.find((a) => a.optional && !a.installed);
	const carrier = asked.find((a) => a.optional === false);
	if (missingOptional && carrier?.installed)
		return (
			`${missingOptional.name} is not installed. It is not a dependency of ${PACKAGE_NAME}, because ` +
			`it carries system-probe, security-agent and their precompiled eBPF objects and most nodes do ` +
			`not run them. Install it to get ${file}: npm install ${missingOptional.name}`
		);

	return `none of ${asked.map((a) => a.name).join(", ")} nor a local build at ${local} resolved ${file}`;
}
