import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ESM replacement for `require.main === module`. Realpath on BOTH sides: npm bin shims
 * and node_modules/.bin reach scripts through symlinks, and the CJS loader resolved
 * those while the ESM loader does not, so comparing unresolved paths would misclassify
 * a symlinked invocation as an import and silently do nothing.
 */
function isCliEntry(moduleUrl) {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
	} catch {
		// An unresolvable argv[1] (deleted or virtual path) cannot be this module.
		return false;
	}
}

/**
 * Run `main` only when this module's script was invoked directly, so a script can export its
 * functions to a unit test and still be a CLI. `main` returns the exit code, or nothing for 0.
 *
 * Every check inside these scripts reports through `::error::`, which is what GitHub renders in
 * a run summary; a crash on the way to one used to print a bare stack that appears only in the
 * raw job log. The release path is where that difference costs the most, since an operator
 * reading a red run reads the summary.
 *
 * `process.exitCode` rather than `process.exit()`: the matrix table goes to stdout immediately
 * before the verdict, and an exit mid-flush truncates it when stdout is a pipe.
 */
export async function runCli(moduleUrl, name, main) {
	if (!isCliEntry(moduleUrl)) return;
	try {
		process.exitCode = (await main()) ?? 0;
	} catch (error) {
		// GitHub ends an annotation at the first newline, so the summary gets the message
		// and the stack that diagnoses it goes to the log underneath.
		console.error(`::error::${name} failed: ${error?.message ?? error}`);
		if (error?.stack) console.error(error.stack);
		process.exitCode = 1;
	}
}
