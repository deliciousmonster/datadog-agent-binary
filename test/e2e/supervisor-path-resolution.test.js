/**
 * How the example supervisor finds Harper's root path, and what it does when nothing names
 * one.
 *
 * The supervisor reads two files it does not own: `~/.harperdb/hdb_boot_properties.file`, and
 * whatever `settings_path` in it points at. Both are Harper's, both are hand-editable, and
 * either can be absent, stale or malformed on a working install. This suite is the proof that
 * each of those returns the next candidate instead of an exception, because the caller is a
 * component loading inside a database node: a throw here takes the node down, and the thing it
 * would be taking down is a supervisor whose entire job is to be unobtrusive.
 *
 * Never the real `~/.harperdb`. Every case runs with `homedir()` pointed at a temp directory.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, createDistSandbox, makeTempDir, withEnv } from '../support/harness.js';

/**
 * The example is loaded from a sandbox copy of the package rather than from example/ itself,
 * because it imports `@deliciousmonster/datadog-agent-binary` by name and example/ has no
 * node_modules. Inside the sandbox the copied manifest carries the package's own name and
 * `exports`, so the bare specifier self-references to the built dist/.
 */
const sandbox = createDistSandbox({ prefix: 'ddab-supervisor-paths-' });
fs.copyFileSync(path.join(REPO_ROOT, 'example', 'dd-supervisor.js'), path.join(sandbox, 'dd-supervisor.js'));
const { resolveRuntimeDir, resolveHarperLogPath } = await import(
	pathToFileURL(path.join(sandbox, 'dd-supervisor.js')).href
);

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/**
 * Run with `homedir()` pointed at a fresh directory and ROOTPATH cleared, so the boot
 * properties are the only thing left that can answer. HOME and USERPROFILE both, because
 * os.homedir() reads whichever one the platform uses.
 */
async function withFakeHome(run) {
	const home = makeTempDir('ddab-home-');
	try {
		return await withEnv('ROOTPATH', undefined, () =>
			withEnv('HOME', home, () => withEnv('USERPROFILE', home, () => run(home)))
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** Harper's boot pointer, in the shape it writes: `key = value`, continuation lines indented. */
function writeBootProperties(home, contents) {
	const dir = path.join(home, '.harperdb');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'hdb_boot_properties.file'), contents);
}

/** A settings file at `<home>/harper-config.yaml` carrying `body`, pointed at by the boot file. */
function installConfig(home, body) {
	const settingsPath = path.join(home, 'harper-config.yaml');
	fs.writeFileSync(settingsPath, body);
	writeBootProperties(home, `settings_path = ${settingsPath}\n    install_user = tester\n`);
	return settingsPath;
}

test('ROOTPATH answers first, without reading anything', async () => {
	const root = makeTempDir('ddab-rootpath-');
	try {
		// The home has a complete, valid chain naming a different root. ROOTPATH still wins:
		// the harper-pro image sets it, and it points at the mounted volume.
		await withFakeHome(async (home) => {
			installConfig(home, `rootPath: ${path.join(home, 'not-this-one')}\n`);
			await withEnv('ROOTPATH', root, () => {
				assert.equal(resolveRuntimeDir(), path.join(root, 'datadog'));
				assert.equal(resolveHarperLogPath(), path.join(root, 'log', 'hdb.log'));
			});
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the root path comes from the settings file the boot properties name', () =>
	withFakeHome((home) => {
		const root = path.join(home, 'harper');
		installConfig(
			home,
			['# Harper node configuration', `rootPath: ${root}`, 'logging:', '  file: true', ''].join('\n')
		);

		assert.equal(resolveRuntimeDir(), path.join(root, 'datadog'));
		assert.equal(resolveHarperLogPath(), path.join(root, 'log', 'hdb.log'));
	}));

test('a quoted rootPath with a trailing comment still parses', () =>
	withFakeHome((home) => {
		const root = path.join(home, 'harper');
		installConfig(home, `rootPath: "${root}"   # set by the installer\n`);

		assert.equal(resolveRuntimeDir(), path.join(root, 'datadog'));
	}));

test('with no boot properties file, the runtime dir falls back and log collection is skipped', () =>
	withFakeHome((home) => {
		assert.equal(resolveRuntimeDir(), path.join(home, '.harper-datadog'));
		assert.equal(
			resolveHarperLogPath(),
			null,
			'a guessed log path produces a source that tails nothing and says so nowhere'
		);
	}));

test('a settings_path pointing at nothing falls through', () =>
	withFakeHome((home) => {
		writeBootProperties(home, `settings_path = ${path.join(home, 'deleted-install', 'harper-config.yaml')}\n`);

		assert.equal(resolveRuntimeDir(), path.join(home, '.harper-datadog'));
		assert.equal(resolveHarperLogPath(), null);
	}));

test('a boot file carrying no settings_path falls through', () =>
	withFakeHome((home) => {
		writeBootProperties(home, 'install_user = tester\nsettings_path\n= /nowhere\n');

		assert.equal(resolveRuntimeDir(), path.join(home, '.harper-datadog'));
		assert.equal(resolveHarperLogPath(), null);
	}));

test(
	'an unreadable boot properties file falls through',
	// root reads a 0-mode file regardless, which would make this pass without proving anything.
	{ skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'chmod does not deny the reader here' },
	() =>
		withFakeHome((home) => {
			writeBootProperties(home, 'settings_path = /nowhere\n');
			const bootFile = path.join(home, '.harperdb', 'hdb_boot_properties.file');
			fs.chmodSync(bootFile, 0o000);
			try {
				assert.equal(resolveRuntimeDir(), path.join(home, '.harper-datadog'));
			} finally {
				fs.chmodSync(bootFile, 0o644);
			}
		})
);

test('a settings file with no usable rootPath falls through', () =>
	withFakeHome((home) => {
		// `rootPath: null` is what Harper's own defaultConfig.yaml ships, and a relative value
		// means nothing from a worker's cwd. Both have to read as absent, not as a directory
		// named "null" under whatever the process happens to be sitting in.
		for (const body of ['rootPath: null\n', 'rootPath: ~\n', 'rootPath: ./harper\n', 'logging:\n  file: true\n']) {
			installConfig(home, body);
			assert.equal(resolveRuntimeDir(), path.join(home, '.harper-datadog'), `for ${JSON.stringify(body)}`);
			assert.equal(resolveHarperLogPath(), null, `for ${JSON.stringify(body)}`);
		}
	}));

test('a nested rootPath key is not mistaken for the top-level one', () =>
	withFakeHome((home) => {
		// Indentation is the only thing separating them, and a line-oriented read that ignored
		// it would hand the agents a component's path as the node's root.
		installConfig(
			home,
			['components:', `  someComponent:`, `    rootPath: ${path.join(home, 'component')}`, ''].join('\n')
		);

		assert.equal(resolveRuntimeDir(), path.join(home, '.harper-datadog'));
	}));
