/**
 * The toolchain guard. Upstream pins the Go it tests against in `.go-version`, and
 * nothing used to read it: CI hardcoded 1.25.8, a local build used whatever was on
 * PATH, and the source asked for 1.25.10 — which is how a package built from
 * 1.25.10-pinned source shipped a go1.26.4 binary.
 *
 * Hermetic: both inputs the check reads (the pin file and `go version`) are stubbed
 * on a subclass, so no toolchain or source tree is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { importDist } from '../support/harness.js';

const { AgentBuilder } = await importDist('builder.js');

/** A builder whose two external reads are fixed values. */
function builderWith({ pin, goVersion }) {
	return new (class extends AgentBuilder {
		async readGoVersionPin() {
			return pin;
		}
		async executeCommand(command) {
			assert.equal(command, 'go version');
			return goVersion;
		}
	})({ sourceDir: '/nonexistent' });
}

const darwin = (v) => `go version go${v} darwin/arm64\n`;

test('a minor-version gap is refused and names both versions', async () => {
	const builder = builderWith({ pin: '1.25.10\n', goVersion: darwin('1.26.4') });
	await assert.rejects(
		() => builder.checkGoVersion(),
		(error) => {
			assert.match(error.message, /1\.25\.10/);
			assert.match(error.message, /go1\.25\.10|GOTOOLCHAIN/);
			return true;
		}
	);
});

test('the exact pinned toolchain passes', async () => {
	const builder = builderWith({ pin: '1.26.5\n', goVersion: darwin('1.26.5') });
	await builder.checkGoVersion();
});

test('a patch gap warns rather than refusing, since upstream floats those', async () => {
	const builder = builderWith({ pin: '1.26.5\n', goVersion: darwin('1.26.6') });
	await builder.checkGoVersion();
});

test('a source shipping no .go-version has no opinion and is not blocked', async () => {
	const builder = builderWith({ pin: undefined, goVersion: darwin('1.26.6') });
	await builder.checkGoVersion();
});

test('an unparseable go version warns rather than guessing', async () => {
	const builder = builderWith({ pin: '1.26.5\n', goVersion: 'go: command not found\n' });
	await builder.checkGoVersion();
});

test('a two-component pin still compares on the minor', async () => {
	await builderWith({ pin: '1.26\n', goVersion: darwin('1.26.6') }).checkGoVersion();
	await assert.rejects(() => builderWith({ pin: '1.25\n', goVersion: darwin('1.26.6') }).checkGoVersion());
});
