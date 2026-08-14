'use strict';

/**
 * The two invariants that keep a published binary the version its label claims:
 * `getPinnedVersion()` refuses to run without `.datadog-agent-version`, and
 * `assertCheckoutMatches()` refuses a working tree that describes as anything
 * but the requested tag. Both exist because this package once shipped agent
 * 7.79.2 inside an artifact labelled 7.75.5.
 *
 * Hermetic: dist/ is copied into a sandbox so the pin file can be rewritten and
 * removed without touching the repo's own. No network; the network-dependent
 * resolveVersion()/getLatestVersion() paths are deliberately not called.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const isWindows = process.platform === 'win32';

/**
 * getPinnedVersion() resolves the pin relative to its own module, so exercising
 * a missing or empty pin needs a copy of dist/ whose parent directory we own.
 * Same sandbox shape as test/e2e/harper-component.test.js, minus the stub
 * platform package it does not need.
 */
function createSandbox() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ddpin-')));
	fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(dir, 'dist'), {
		recursive: true,
	});
	const targetModules = path.join(dir, 'node_modules');
	fs.mkdirSync(targetModules);
	const sourceModules = path.join(REPO_ROOT, 'node_modules');
	for (const entry of fs.readdirSync(sourceModules)) {
		const source = path.join(sourceModules, entry);
		if (!fs.statSync(source).isDirectory()) continue;
		fs.symlinkSync(source, path.join(targetModules, entry), isWindows ? 'junction' : 'dir');
	}
	return dir;
}

const sandbox = createSandbox();
const pinPath = path.join(sandbox, '.datadog-agent-version');
const { DatadogAgentDownloader } = require(path.join(sandbox, 'dist', 'downloader.js'));

test.after(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a missing pin file is fatal, not a fallback to upstream latest', async () => {
	fs.rmSync(pinPath, { force: true });
	// The old behaviour was to float to getLatestVersion(); a resolved version
	// here would mean the pin is advisory again.
	await assert.rejects(
		() => new DatadogAgentDownloader().getPinnedVersion(),
		(error) => error.message.includes(pinPath) && /must not\s+silently float/.test(error.message),
		'the error must name the pin path and the floating-version hazard'
	);
});

test('an empty pin file is fatal', async () => {
	fs.writeFileSync(pinPath, '\n\t \n');
	await assert.rejects(() => new DatadogAgentDownloader().getPinnedVersion(), /is empty/);
});

test('the pin is returned trimmed, exactly as written', async () => {
	fs.writeFileSync(pinPath, '7.60.1\n');
	assert.equal(await new DatadogAgentDownloader().getPinnedVersion(), '7.60.1');
});

test('a clone describing past the tag is refused', () => {
	const downloader = new DatadogAgentDownloader();
	// `git describe` output for commits after the tag; building it would label
	// the artifact 7.60.1 while containing something newer.
	assert.throws(() => downloader['assertCheckoutMatches']('7.60.1', '7.60.1-3-gabc1234'), /Refusing to continue/);
});

test('a clone describing as a bare sha is refused', () => {
	const downloader = new DatadogAgentDownloader();
	assert.throws(
		() => downloader['assertCheckoutMatches']('7.60.1', 'abc1234'),
		(error) => error.message.includes('7.60.1') && error.message.includes('abc1234'),
		'the refusal must name both the requested and the described version'
	);
});

test('an exact tag match is the only accepted checkout', () => {
	const downloader = new DatadogAgentDownloader();
	assert.doesNotThrow(() => downloader['assertCheckoutMatches']('7.60.1', '7.60.1'));
	// Same digits, different tag: prefix or suffix matching would accept these.
	assert.throws(() => downloader['assertCheckoutMatches']('7.60.1', '7.60.10'));
	assert.throws(() => downloader['assertCheckoutMatches']('7.60.1', 'v7.60.1'));
});
