/**
 * Shared preamble for the Harper integration suites. harper-spawn.test.ts and
 * harper-import.test.ts run against a real Harper through
 * @harperfast/integration-testing and carried byte-identical copies of these
 * helpers; a fix to one copy silently stranded the other (both embedded the
 * same ifconfig instructions and the same pool-start parsing), so they live
 * here once. Not collected as a test: the runner glob only matches *.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);

/**
 * The `harper` package's exports map only exposes ".", so the harness's
 * auto-resolution of 'harper/dist/bin/harper.js' fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package entry (which the map does
 * expose) and walk to the bin script from there. Same workaround
 * harperfast/application-template carries in its own tests.
 */
export function resolveHarperBinPath(): string | null {
	try {
		return resolve(dirname(require.resolve('harper')), 'bin/harper.js');
	} catch {
		return null;
	}
}

/**
 * First address the harness's loopback pool hands out. Linux binds all of 127/8
 * out of the box; macOS configures only 127.0.0.1, so on a Mac without the alias
 * the harness's first bind dies in LoopbackAddressValidationError. That is a
 * missing prerequisite, not a failure, so probe it up front and skip.
 */
const LOOPBACK_POOL_START = Number.parseInt(process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START ?? '', 10);
const LOOPBACK_PROBE_ADDRESS = `127.0.0.${Number.isNaN(LOOPBACK_POOL_START) ? 2 : LOOPBACK_POOL_START}`;

function canBindLoopbackAddress(address: string): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once('error', () => resolve(false));
		// Port 0: the probe is about the address; any bindable port proves it.
		server.listen({ host: address, port: 0 }, () => {
			server.close(() => resolve(true));
		});
	});
}

/**
 * The clause both suites end their SKIP_REASON ternary with: the reason to
 * skip on a Mac that cannot bind the pool's first address, with the fix in
 * the message, or false anywhere the probe succeeds or does not apply.
 */
export async function darwinLoopbackSkipReason(): Promise<string | false> {
	if (process.platform !== 'darwin') return false;
	if (await canBindLoopbackAddress(LOOPBACK_PROBE_ADDRESS)) return false;
	return (
		`this machine cannot bind ${LOOPBACK_PROBE_ADDRESS}, the first address in ` +
		`the harness's loopback pool; macOS enables only 127.0.0.1 by default. ` +
		`Run \`sudo ifconfig lo0 alias ${LOOPBACK_PROBE_ADDRESS} up\` (or ` +
		`\`npx harper-integration-test-setup-loopback\` for the whole pool)`
	);
}

/**
 * A temp directory whose path is already resolved: on macOS os.tmpdir() lives
 * under a /var -> /private/var symlink, while the paths both suites compare
 * against it (ps(1) output, a Harper install dir) are the resolved spelling.
 */
export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Rows of a probe-results file holding one JSON record per line. */
export function readJsonlRows<T>(resultsFile: string): T[] {
	if (!existsSync(resultsFile)) return [];
	return readFileSync(resultsFile, 'utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as T];
			} catch {
				// A record is written in a single appendFileSync, so a torn line should
				// be impossible; tolerate one rather than failing on it.
				return [];
			}
		});
}

/**
 * Re-read the probe file until `isComplete` accepts what is there, then hand
 * those rows back. On timeout the rows are returned anyway: what a component
 * managed to write before giving up is what the assertions report on, and a
 * throw here would replace every one of their messages with this one.
 */
export async function pollJsonlRows<T>(
	resultsFile: string,
	isComplete: (rows: T[]) => boolean,
	{ timeoutMs = 60000, intervalMs = 200 } = {}
): Promise<T[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = readJsonlRows<T>(resultsFile);
		if (isComplete(rows)) return rows;
		await sleep(intervalMs);
	}
	return readJsonlRows<T>(resultsFile);
}

/**
 * What a thrown value should read as in a skip or failure message. Takes
 * .message off any object rather than narrowing to Error the way
 * src/logger.ts's errorMessage() does, preserving what both suites inlined;
 * execFileSync failures are the main thing rendered here. The probe fixtures
 * staged into Harper app dirs keep their own inline copies, because a staged
 * application cannot resolve this module.
 */
export function errorMessage(error: unknown): string {
	const message = (error as { message?: unknown } | null | undefined)?.message;
	return String(message ?? error);
}
