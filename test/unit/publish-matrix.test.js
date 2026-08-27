import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { expectedPackages, readLocal, verify, PACKAGE_NAME, PACKAGE_VERSION } from '../../scripts/publish-matrix.js';
import { withTempDir } from '../support/harness.js';

// verify() rejects a binary below a size floor, so a fixture standing in for a
// real agent has to clear it. truncate sets the size without writing the bytes.
const REALISTIC_BINARY_BYTES = 2 * 1024 * 1024;

/** Stage a package dir on disk the way create-platform-packages.js would. */
function stage(dir, platform, { name, os: pkgOs, cpu, version, binaries, binaryBytes = REALISTIC_BINARY_BYTES }) {
	const packageDir = path.join(dir, platform);
	fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, 'package.json'),
		JSON.stringify({
			name: name ?? `${PACKAGE_NAME}-${platform}`,
			version: version ?? PACKAGE_VERSION,
			os: pkgOs,
			cpu,
		})
	);
	for (const name of binaries) {
		const binaryPath = path.join(packageDir, 'bin', name);
		fs.writeFileSync(binaryPath, '');
		fs.truncateSync(binaryPath, binaryBytes);
	}
}

/** Stage every expected platform correctly, then let the caller break one. */
function stageAll(dir, mutate = () => {}) {
	for (const expected of expectedPackages()) {
		const nodeOs = expected.platform.startsWith('linux')
			? 'linux'
			: expected.platform.startsWith('macos')
				? 'darwin'
				: 'win32';
		const nodeCpu = expected.platform.endsWith('arm64') ? 'arm64' : 'x64';
		const spec = { os: [nodeOs], cpu: [nodeCpu], binaries: expected.binaries };
		mutate(expected.platform, spec);
		stage(dir, expected.platform, spec);
	}
}

function rowsFor(dir) {
	return expectedPackages().map((e) => readLocal(e, dir));
}

test('a correctly staged matrix has no problems', () =>
	withTempDir('ddab-matrix-', (dir) => {
		stageAll(dir);
		assert.deepEqual(verify(rowsFor(dir)), []);
	}));

test("rejects this project's internal os/cpu names (the macos-x86_64 defect)", () =>
	withTempDir('ddab-matrix-', (dir) => {
		// Exactly what shipped: our own vocabulary instead of Node's. npm compares these
		// against process.platform/process.arch, so the package could never install, and
		// because the dependency is optional the failure was completely silent.
		stageAll(dir, (platform, spec) => {
			if (platform === 'macos-arm64') {
				spec.os = ['macos'];
				spec.cpu = ['x86_64'];
			}
		});
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /os "macos" is not a Node process.platform/.test(p)),
			`expected an os rejection, got: ${problems.join(' | ')}`
		);
		assert.ok(
			problems.some((p) => /cpu "x86_64" is not a Node process.arch/.test(p)),
			`expected a cpu rejection, got: ${problems.join(' | ')}`
		);
	}));

test('rejects a package that declares no os or cpu at all', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// npm reads a missing list as "installs everywhere", so this package resolves on
		// every host and hands out one platform's binaries to all of them. The gate only
		// ever compared the values it found, so a manifest with none passed clean.
		stageAll(dir, (platform, spec) => {
			if (platform === 'linux-arm64') {
				delete spec.os;
				delete spec.cpu;
			}
		});
		const problems = verify(rowsFor(dir));
		for (const field of ['os', 'cpu']) {
			assert.ok(
				problems.some((p) => /linux-arm64/.test(p) && new RegExp(`${field} is empty or absent`).test(p)),
				`expected an absent-${field} problem, got: ${problems.join(' | ')}`
			);
		}
	}));

test('rejects a staged package whose manifest names a different package', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// The directory decides what gets published; the manifest decides under what name.
		// A re-scope that missed the generator would publish the new name while
		// optionalDependencies still asked for the old one, and npm skips an unresolvable
		// optional dependency without a word.
		stageAll(dir, (platform, spec) => {
			if (platform === 'macos-arm64') spec.name = '@somebody-else/datadog-agent-binary-macos-arm64';
		});
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /calls itself "@somebody-else\/datadog-agent-binary-macos-arm64"/.test(p)),
			`expected a manifest-name problem, got: ${problems.join(' | ')}`
		);
	}));

test('rejects a package missing the trace-agent (the original defect)', () =>
	withTempDir('ddab-matrix-', (dir) => {
		stageAll(dir, (platform, spec) => {
			if (platform === 'linux-x86_64') {
				// Core agent only, which is precisely what was published: nothing binds
				// 127.0.0.1:8126 and every span is dropped without an error anywhere.
				spec.binaries = spec.binaries.filter((b) => !b.startsWith('trace-agent'));
			}
		});
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /missing trace-agent/.test(p)),
			`expected a missing-binary problem, got: ${problems.join(' | ')}`
		);
	}));

test('an empty bin/ is a problem, not a silent pass', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// The gate inferred "this is a --dummy package" from an empty bin/ and skipped its
		// own per-binary check, so a staging with four correct manifests and no binaries at
		// all cleared the last step before `npm publish` reporting zero problems.
		stageAll(dir, (platform, spec) => {
			if (platform === 'linux-x86_64') spec.binaries = [];
		});
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /linux-x86_64/.test(p) && /missing trace-agent/.test(p)),
			`a staged package with no binaries must not clear the pre-publish gate, got: ${problems.join(' | ')}`
		);
	}));

test('rejects a binary too small to be a real agent', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// Both filenames present, no content behind them. A check that only matches names
		// passes this and prints 0 MB in the SIZE column next to OK.
		stageAll(dir, (platform, spec) => {
			if (platform === 'macos-arm64') spec.binaryBytes = 0;
		});
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /macos-arm64/.test(p) && /trace-agent is 0 bytes/.test(p)),
			`expected a size-floor problem, got: ${problems.join(' | ')}`
		);
	}));

test('rejects a platform package whose version has drifted from the main package', () =>
	withTempDir('ddab-matrix-', (dir) => {
		stageAll(dir, (platform, spec) => {
			if (platform === 'linux-arm64') spec.version = '0.0.1';
		});
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /does not match the main package/.test(p)),
			`expected a version-skew problem, got: ${problems.join(' | ')}`
		);
	}));

test('reports a declared platform that was never staged', () =>
	withTempDir('ddab-matrix-', (dir) => {
		stageAll(dir);
		// A build leg that failed: the package is declared but absent.
		const victim = expectedPackages()[0].platform;
		fs.rmSync(path.join(dir, victim), { recursive: true, force: true });
		const problems = verify(rowsFor(dir));
		assert.ok(
			problems.some((p) => /not found/.test(p) && /skip it silently/.test(p)),
			`expected a not-found problem, got: ${problems.join(' | ')}`
		);
	}));

// verify() compares optionalDependencies against SUPPORTED_PLATFORMS. A platform
// declared but never built is what made Intel-Mac installs resolve nothing at all,
// silently, because npm skips an unresolvable optional dependency without a warning.
// Asserted both ways: the repo is in sync now, and a drift would actually be caught.
test('optionalDependencies matches SUPPORTED_PLATFORMS, and drift is detected', () =>
	withTempDir('ddab-matrix-', (dir) => {
		stageAll(dir);
		const problems = verify(rowsFor(dir));
		assert.ok(
			!problems.some((p) => /does not match SUPPORTED_PLATFORMS/.test(p)),
			`optionalDependencies is out of sync: ${problems.join(' | ')}`
		);

		// Stage a platform nobody declares. Without the negative case this test would
		// still pass if the check were deleted from verify() entirely.
		stage(dir, 'solaris-sparc', { os: ['sunos'], cpu: ['sparc'], binaries: ['datadog-agent', 'trace-agent'] });
		const undeclared = {
			platform: 'solaris-sparc',
			name: `${PACKAGE_NAME}-solaris-sparc`,
			binaries: ['datadog-agent', 'trace-agent'],
		};
		const rows = [...rowsFor(dir), readLocal(undeclared, dir)];
		assert.ok(
			verify(rows).some((p) => /does not match SUPPORTED_PLATFORMS/.test(p)),
			'an undeclared platform should be reported'
		);
	}));

test('a --deep tarball read that failed is a problem, not a silent downgrade', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// The message used to be written to row.deepError and read by nothing. `files` stayed
		// null, so the authoritative per-binary check was skipped and the gate fell through to
		// the fileCount heuristic -- which counts 5 files and passes a package holding the
		// wrong five. A release could be reported "verified" with nothing having read the
		// tarball at all.
		stageAll(dir);
		const rows = rowsFor(dir);
		rows[0].files = null;
		rows[0].deepError = 'socket hang up';

		const problems = verify(rows);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /could not inspect the published tarball \(socket hang up\)/);
		assert.match(problems[0], /not proven/);
	}));

test('a published package that reports nothing about its bin/ is unverified, not OK', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// --registry without --deep leans entirely on dist.fileCount. A manifest carrying
		// none matched neither the file-list check nor the count heuristic, so the run
		// printed OK having verified nothing about what was published.
		stageAll(dir);
		const rows = rowsFor(dir);
		rows[0].files = null;
		delete rows[0].sizes;
		rows[0].bytes = 12_000;

		const problems = verify(rows);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /unverified/);
	}));

test('a published package too small to hold its binaries is a problem', () =>
	withTempDir('ddab-matrix-', (dir) => {
		// The count heuristic is satisfied by five files of any size, so without a floor a
		// tarball holding two empty binaries is indistinguishable from a real release.
		stageAll(dir);
		const rows = rowsFor(dir);
		rows[0].files = null;
		delete rows[0].sizes;
		rows[0].fileCount = 5;
		rows[0].bytes = 40 * 1024;

		const problems = verify(rows);
		assert.equal(problems.length, 1);
		assert.match(problems[0], /cannot hold/);
	}));
