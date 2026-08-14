/**
 * Pins the one load-bearing assumption of the ESM-only decision (wave4/ESM-DECISION.md):
 * a CommonJS consumer on the shared engines floor (^22.18.0 || >=24.0.0) can require()
 * this package, because Node's require(esm) loads an ES module whose graph is
 * synchronous. No such consumer exists today, but the Harper server ships CJS, so a
 * future server dependency would take exactly this path.
 *
 * require(esm) works only while the module graph stays synchronous. If top-level await
 * ever enters src/, this test fails with ERR_REQUIRE_ASYNC_MODULE, in CI, instead of the
 * same error surfacing in a hypothetical server consumer's production install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ENTRY_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'index.js');

test('require() of the built ESM entry point reaches the whole public API', () => {
	// The BUILT entry, not src: this must prove the artifact a consumer installs,
	// including whatever tsc emitted for the transitive graph behind it.
	const api = require(ENTRY_PATH);
	for (const name of ['BinaryManager', 'DatadogAgentBuilder', 'DatadogAgentDownloader', 'createBuilder', 'Platform']) {
		assert.equal(
			typeof api[name],
			'function',
			`${name} must be reachable through require(); a miss means the module graph ` +
				`went asynchronous (or the export was dropped) and CJS consumers are broken`
		);
	}
});
