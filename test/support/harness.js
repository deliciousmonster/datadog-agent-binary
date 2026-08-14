/**
 * Shared preamble for the hermetic suites under test/unit and test/e2e.
 *
 * Each of them locates the repo, imports something out of the built dist/, or
 * assembles a throwaway copy of the package, and each had grown its own
 * spelling: three findRepoRoot() walks, five copies of the pathToFileURL
 * comment, seven mkdtemp calls with the /private/var explanation restated in
 * four of them. A fix to one copy stranded the rest.
 *
 * The integration suites cannot import this file: they are TypeScript, and
 * tsconfig.test.json compiles them with allowJs off, so an untyped .js import
 * fails the typecheck gate. What those two share lives in
 * test/integration/support/harness.ts instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** test/support sits two levels below the repo root. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * The repo manifest. Suites derive the package name and version from it rather
 * than hardcoding either: a test pinning the old scope would keep passing
 * against a stale assumption after a re-scope.
 */
export const PACKAGE_MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/**
 * Import a compiled module from a built dist/ - this repo's, or a sandbox copy
 * when `root` is given. pathToFileURL because import() of a bare absolute path
 * is rejected on Windows.
 */
export function importDist(file, root = REPO_ROOT) {
	return import(pathToFileURL(path.join(root, 'dist', file)).href);
}

/**
 * A temp directory whose path is already resolved: on macOS os.tmpdir() lives
 * under a /var -> /private/var symlink, while everything a suite compares it
 * against (ps(1) output, the __dirname a module loaded from inside it reports)
 * is the resolved spelling.
 */
export function makeTempDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * makeTempDir() around `run`, removed however `run` ends. The result is
 * awaited, so a test must RETURN this call rather than fire and forget it: a
 * synchronous callback that threw would otherwise reject a promise nobody
 * holds, and the test would pass.
 */
export async function withTempDir(prefix, run) {
	const dir = makeTempDir(prefix);
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A throwaway copy of the built package: dist/, whatever else `include` names,
 * the manifest, and a node_modules of symlinks into this repo's own.
 *
 * The manifest is copied because it carries "type": "module", which is what
 * makes the copied dist/*.js load as ESM; without it Node falls back to
 * per-file syntax detection. `shadowed` names top-level node_modules entries to
 * leave unlinked, which is how a caller substitutes a stub of its own:
 * symlinking the package scope would let a real installed platform package win,
 * and the stub would never be exercised.
 */
export function createDistSandbox({ prefix, include = [], shadowed = [] }) {
	const dir = makeTempDir(prefix);
	for (const entry of ['dist', ...include]) {
		fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), {
			recursive: true,
		});
	}
	fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(dir, 'package.json'));

	const targetModules = path.join(dir, 'node_modules');
	fs.mkdirSync(targetModules, { recursive: true });
	const sourceModules = path.join(REPO_ROOT, 'node_modules');
	for (const entry of fs.readdirSync(sourceModules)) {
		if (shadowed.includes(entry)) continue;
		const source = path.join(sourceModules, entry);
		if (!fs.statSync(source).isDirectory()) continue;
		// "junction" is the only directory link Windows creates without elevation.
		fs.symlinkSync(source, path.join(targetModules, entry), process.platform === 'win32' ? 'junction' : 'dir');
	}
	return dir;
}

/**
 * Run with process.env[name] set to `value`, or removed when `value` is
 * undefined, restoring the previous state however `run` ends. Unset and empty
 * are kept distinct: the launcher's fallbacks read the difference.
 */
export async function withEnv(name, value, run) {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}
