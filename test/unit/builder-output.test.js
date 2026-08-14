/**
 * `copyBinariesToOutput()`, the last step of every build. It must ship BOTH
 * binaries or refuse loudly: a build that copies the core agent and quietly
 * skips the trace-agent published once already, and the only symptom was
 * dd-trace flushing spans into a closed socket.
 *
 * Hermetic: stub files in temp dirs stand in for the compiled binaries; no
 * build toolchain runs (createBuilder() only selects a class).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
// Via the package entry point, the same surface cli.ts builds against.
// pathToFileURL because import() of a bare absolute path is rejected on Windows.
const { createBuilder, Platform } = await import(pathToFileURL(path.join(REPO_ROOT, 'dist', 'index.js')).href);

const platform = Platform.current();
const isWindows = process.platform === 'win32';

/**
 * A source tree shaped the way upstream's invoke tasks leave it:
 * <sourceDir>/bin/<buildDir>/<buildName> for each binary in `kinds`.
 */
function createBuildTree(kinds) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ddbo-')));
	const sourceDir = path.join(dir, 'src');
	const outputDir = path.join(dir, 'out');
	for (const kind of kinds) {
		const descriptor = platform.getBinary(kind);
		const buildDir = path.join(sourceDir, 'bin', descriptor.buildDir);
		fs.mkdirSync(buildDir, { recursive: true });
		fs.writeFileSync(path.join(buildDir, descriptor.buildName), kind);
	}
	return { dir, sourceDir, outputDir };
}

async function copyBinaries(tree) {
	const builder = createBuilder({
		platform,
		outputDir: tree.outputDir,
		sourceDir: tree.sourceDir,
	});
	// Protected in TS; the access modifier is erased in the compiled output.
	return builder['copyBinariesToOutput']();
}

test('a full build tree yields both binaries, runnable, under outputDir', async () => {
	const tree = createBuildTree(['core', 'trace']);
	try {
		const outputPaths = await copyBinaries(tree);
		assert.deepEqual(Object.keys(outputPaths).sort(), ['core', 'trace']);
		for (const kind of ['core', 'trace']) {
			const outputPath = outputPaths[kind];
			assert.equal(outputPath, path.resolve(tree.outputDir, platform.getBinary(kind).outputName));
			assert.equal(
				fs.readFileSync(outputPath, 'utf8'),
				kind,
				`${kind}: the copied file must be the ${kind} build product`
			);
			if (!isWindows) {
				// npm carries mode bits through pack; without the exec bit the binary
				// installs unrunnable and dies at spawn with EACCES.
				assert.ok(fs.statSync(outputPath).mode & 0o111, `${kind}: ${outputPath} is not executable`);
			}
		}
	} finally {
		fs.rmSync(tree.dir, { recursive: true, force: true });
	}
});

test('a tree missing the trace-agent is refused, naming binary and build task', async () => {
	const tree = createBuildTree(['core']);
	try {
		await assert.rejects(
			() => copyBinaries(tree),
			(error) => /Missing trace agent binary/.test(error.message) && error.message.includes('trace-agent.build'),
			'a core-only tree must refuse to ship, and the error must say which ' + 'invoke task did not run'
		);
	} finally {
		fs.rmSync(tree.dir, { recursive: true, force: true });
	}
});

test('a tree missing the core agent is refused too; the gate is per binary', async () => {
	const tree = createBuildTree(['trace']);
	try {
		await assert.rejects(() => copyBinaries(tree), /Missing core agent binary/);
	} finally {
		fs.rmSync(tree.dir, { recursive: true, force: true });
	}
});

test('createBuilder() refuses an OS it has no builder for', () => {
	assert.throws(
		() =>
			createBuilder({
				platform: { getOS: () => 'beos' },
				outputDir: '.',
				sourceDir: '.',
			}),
		/Unsupported OS: beos/
	);
});
