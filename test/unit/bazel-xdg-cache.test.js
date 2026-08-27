/**
 * The cache directory upstream's bazel wrapper demands. `tools/bazel` exits 2 when `CI`
 * is set and XDG_CACHE_HOME does not already name an absolute directory, so a runner
 * died inside `agent.build` while the same build passed on a laptop, where the wrapper
 * only prints a hint.
 *
 * Hermetic: HOME and USERPROFILE point at a temp directory, so the default branch never
 * writes to the real home.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, withEnv, withTempDir } from '../support/harness.js';

const { AgentBuilder } = await importDist('builder.js');
const { Platform } = await importDist('platform.js');

const builder = () =>
	new AgentBuilder({
		platform: new Platform('linux', 'x86_64'),
		sourceDir: '/nonexistent',
		outputDir: '/nonexistent/out',
	});

/** os.homedir() reads HOME on POSIX and USERPROFILE on Windows. */
const withHome = (home, run) => withEnv('HOME', home, () => withEnv('USERPROFILE', home, run));

test('under CI with no XDG_CACHE_HOME, the XDG default is created and exported', async () => {
	await withTempDir('xdg-default-', (home) =>
		withHome(home, () =>
			withEnv('CI', 'true', () =>
				withEnv('XDG_CACHE_HOME', undefined, async () => {
					const build = builder();
					await build.ensureCacheDirectory();

					const expected = path.join(home, '.cache');
					assert.ok(fs.statSync(expected).isDirectory());
					assert.equal(build.getEnvironmentVariables().XDG_CACHE_HOME, expected);
				})
			)
		)
	);
});

test('an explicit XDG_CACHE_HOME wins and is created when it does not exist yet', async () => {
	await withTempDir('xdg-explicit-', (home) =>
		withHome(home, () => {
			const requested = path.join(home, 'workspace', '.cache');
			return withEnv('CI', 'true', () =>
				withEnv('XDG_CACHE_HOME', requested, async () => {
					const build = builder();
					await build.ensureCacheDirectory();

					assert.ok(fs.statSync(requested).isDirectory());
					assert.equal(build.getEnvironmentVariables().XDG_CACHE_HOME, requested);
					assert.ok(!fs.existsSync(path.join(home, '.cache')));
				})
			);
		})
	);
});

test('an empty XDG_CACHE_HOME is treated as unset, since the wrapper rejects it too', async () => {
	await withTempDir('xdg-empty-', (home) =>
		withHome(home, () =>
			withEnv('CI', 'true', () =>
				withEnv('XDG_CACHE_HOME', '  ', async () => {
					const build = builder();
					await build.ensureCacheDirectory();

					assert.equal(build.getEnvironmentVariables().XDG_CACHE_HOME, path.join(home, '.cache'));
				})
			)
		)
	);
});

test('off CI nothing is created and no XDG_CACHE_HOME is exported', async () => {
	await withTempDir('xdg-local-', (home) =>
		withHome(home, () => {
			const requested = path.join(home, 'workspace', '.cache');
			return withEnv('CI', undefined, () =>
				withEnv('XDG_CACHE_HOME', requested, async () => {
					const build = builder();
					await build.ensureCacheDirectory();

					assert.ok(!fs.existsSync(requested));
					assert.ok(!fs.existsSync(path.join(home, '.cache')));
					assert.ok(!('XDG_CACHE_HOME' in build.getEnvironmentVariables()));
				})
			);
		})
	);
});

test('every build precondition runs before dda is installed', async () => {
	const order = [];
	const build = new (class extends AgentBuilder {
		async ensureXcodeTools() {
			order.push('xcode');
		}
		async ensureGoVersion() {
			order.push('go');
		}
		async ensureCacheDirectory() {
			order.push('cache');
		}
		// Stubbed rather than left to run: sourceDir is deliberately unwritable here.
		async ensureEmbeddedPath() {
			order.push('dev');
		}
		async ensureWindowsPreconditions() {
			order.push('windows');
		}
		async ensureDdaInstalled() {
			order.push('dda');
		}
		async executeCommand() {
			return '';
		}
		async streamCommand() {}
	})({ platform: new Platform('linux', 'x86_64'), sourceDir: '/nonexistent', outputDir: '/nonexistent/out' });

	await build.buildCommon();
	// Every guard in one list: the macOS toolchain check used to sit a level up in
	// build(), where this assertion could not see it at all.
	assert.deepEqual(order, ['xcode', 'go', 'cache', 'dev', 'windows', 'dda']);
});
