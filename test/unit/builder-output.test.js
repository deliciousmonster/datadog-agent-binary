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
import path from 'node:path';

import { importDist, withTempDir } from '../support/harness.js';

// Via the package entry point, the same surface cli.ts builds against.
const { createBuilder, Platform } = await importDist('index.js');

const platform = Platform.current();
const isWindows = process.platform === 'win32';

/**
 * Lay out a source tree the way upstream's invoke tasks leave one -
 * <sourceDir>/bin/<buildDir>/<buildName> for each binary in `kinds` - and run
 * the copy step against it.
 */
function copyBinaries(dir, kinds) {
	const sourceDir = path.join(dir, 'src');
	for (const kind of kinds) {
		const descriptor = platform.getBinary(kind);
		const buildDir = path.join(sourceDir, 'bin', descriptor.buildDir);
		fs.mkdirSync(buildDir, { recursive: true });
		fs.writeFileSync(path.join(buildDir, descriptor.buildName), kind);
	}
	const builder = createBuilder({
		platform,
		outputDir: path.join(dir, 'out'),
		sourceDir,
	});
	// Protected in TS; the access modifier is erased in the compiled output.
	return builder['copyBinariesToOutput']();
}

test('a full build tree yields both binaries, runnable, under outputDir', () =>
	withTempDir('ddbo-', async (dir) => {
		const outputPaths = await copyBinaries(dir, ['core', 'trace']);
		assert.deepEqual(Object.keys(outputPaths).sort(), ['core', 'trace']);
		for (const kind of ['core', 'trace']) {
			const outputPath = outputPaths[kind];
			assert.equal(outputPath, path.resolve(dir, 'out', platform.getBinary(kind).outputName));
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
	}));

test('a tree missing the trace-agent is refused, naming binary and build task', () =>
	withTempDir('ddbo-', (dir) =>
		assert.rejects(
			() => copyBinaries(dir, ['core']),
			(error) => /Missing trace agent binary/.test(error.message) && error.message.includes('trace-agent.build'),
			'a core-only tree must refuse to ship, and the error must say which ' + 'invoke task did not run'
		)
	));

test('a tree missing the core agent is refused too; the gate is per binary', () =>
	withTempDir('ddbo-', (dir) => assert.rejects(() => copyBinaries(dir, ['trace']), /Missing core agent binary/)));

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
