// Shared by the bin shim and resources.js: both launch the same two binaries, and both used to report every
// failure as one sentence, when "failed to execute" and exit code 0 are the two readings that mislead most.

import { constants } from "node:os";

// Signals a supervisor sends on the way down. Anything else reaching a child is a crash or an OOM kill,
// and a Go agent that never installed a handler exits with no code at all either way.
const SHUTDOWN_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGHUP"]);

const SPAWN_FAILURES = {
	// X_OK passes for a binary built for another architecture, so this is the one cause no preflight sees.
	ENOEXEC: (path) =>
		`${path} is not executable code for this machine (ENOEXEC). A platform ` +
		`package filled from another architecture produces exactly this; check with \`file ${path}\`.`,
	EACCES: (path) =>
		`${path} is not executable by this user (EACCES). Check the file mode, ` +
		`then every directory on the path to it, then whether the volume is mounted noexec.`,
	ENOENT: (path) =>
		`${path} does not exist (ENOENT). The platform package resolved a path ` +
		`and nothing is at it, so the package installed without its binary.`,
};

/** Why a spawn was refused, named. Falls back to the thrown message, which is what Harper's own refusals carry. */
export function describeSpawnFailure(error, binaryPath) {
	const code =
		error instanceof Error && typeof error.code === "string"
			? error.code
			: undefined;
	const known = code === undefined ? undefined : SPAWN_FAILURES[code];
	if (known) return known(binaryPath);
	return error instanceof Error ? error.message : String(error);
}

/**
 * How a child ended, in the terms that separate a shutdown from a kill.
 * A signalled process reports code `null`, which reads as a clean stop everywhere `code || 0` is written.
 */
export function describeExit(code, signal) {
	if (signal) {
		if (SHUTDOWN_SIGNALS.has(signal)) {
			return {
				killed: false,
				detail: `terminated by ${signal}`,
				exitCode: 128 + (constants.signals[signal] ?? 0),
			};
		}
		return {
			killed: true,
			detail: `killed by ${signal}, which is a crash or an OOM kill rather than a shutdown`,
			exitCode: 128 + (constants.signals[signal] ?? 0),
		};
	}
	if (code === 0)
		return { killed: false, detail: "exited cleanly", exitCode: 0 };
	return {
		killed: false,
		detail: `exited with code ${code}`,
		exitCode: code ?? 1,
	};
}
