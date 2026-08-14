import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ESM replacement for `require.main === module`, so a script both exports functions
 * for its unit tests and runs its CLI when invoked directly. Realpath on BOTH sides:
 * npm bin shims and node_modules/.bin reach scripts through symlinks, and the CJS
 * loader resolved those while the ESM loader does not, so comparing unresolved paths
 * would misclassify a symlinked invocation as an import and silently do nothing.
 */
export function isCliEntry(moduleUrl) {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
	} catch {
		// An unresolvable argv[1] (deleted or virtual path) cannot be this module.
		return false;
	}
}
