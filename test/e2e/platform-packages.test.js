import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { PACKAGE_MANIFEST as mainPkg, REPO_ROOT, makeTempDir } from '../support/harness.js';

const PACKAGE_NAME = mainPkg.name;

// Every published binary, per platform: the accessor the platform package must
// export and the filename that accessor has to resolve inside bin/. Written out
// literally rather than read back from Platform.getBinaries(), so a descriptor
// change has to be restated here; the generator reading its own input proves
// nothing about what actually ships.
const CORE = { kind: 'core', accessor: 'getBinaryPath' };
const TRACE = { kind: 'trace', accessor: 'getTraceAgentBinaryPath' };

const UNIX_BINARIES = [
	{ ...CORE, file: 'datadog-agent' },
	{ ...TRACE, file: 'trace-agent' },
];
const WINDOWS_BINARIES = [
	{ ...CORE, file: 'datadog-agent.exe' },
	{ ...TRACE, file: 'trace-agent.exe' },
];

// What each generated platform package's os/cpu MUST be (Node's values), and
// what its index.js must resolve.
const EXPECTED = {
	// libc on the Linux entries: CGO_ENABLED=1 links glibc, so npm must skip
	// these packages on musl instead of installing a binary that dies ENOENT.
	'linux-x86_64': {
		os: 'linux',
		cpu: 'x64',
		libc: ['glibc'],
		binaries: UNIX_BINARIES,
	},
	'linux-arm64': {
		os: 'linux',
		cpu: 'arm64',
		libc: ['glibc'],
		binaries: UNIX_BINARIES,
	},
	'macos-arm64': { os: 'darwin', cpu: 'arm64', binaries: UNIX_BINARIES },
	'windows-x86_64': { os: 'win32', cpu: 'x64', binaries: WINDOWS_BINARIES },
};

let workDir;
let npmDir;
/** Every generated package.json, read back once the generator has run. */
let generated;

before(() => {
	// Run the generator in an isolated copy so we don't write into the repo.
	workDir = makeTempDir('ddab-platform-pkgs-');
	fs.mkdirSync(path.join(workDir, 'scripts'));
	fs.mkdirSync(path.join(workDir, 'dist'));
	fs.copyFileSync(
		path.join(REPO_ROOT, 'scripts', 'create-platform-packages.js'),
		path.join(workDir, 'scripts', 'create-platform-packages.js')
	);
	// The generator only requires dist/platform.js (type imports are erased).
	fs.copyFileSync(path.join(REPO_ROOT, 'dist', 'platform.js'), path.join(workDir, 'dist', 'platform.js'));
	fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(workDir, 'package.json'));

	execFileSync(process.execPath, [path.join(workDir, 'scripts', 'create-platform-packages.js'), '--dummy'], {
		stdio: 'ignore',
	});
	npmDir = path.join(workDir, 'npm');
	generated = readGenerated();
});

after(() => {
	if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

function readGenerated() {
	const out = {};
	for (const name of fs.readdirSync(npmDir)) {
		const pj = path.join(npmDir, name, 'package.json');
		if (fs.existsSync(pj)) {
			out[name] = JSON.parse(fs.readFileSync(pj, 'utf8'));
		}
	}
	return out;
}

test('generates exactly the expected set of platform packages', () => {
	assert.deepEqual(Object.keys(generated).sort(), Object.keys(EXPECTED).sort());
});

test('each platform package has npm-valid os/cpu (Node values, not human-readable)', () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const pkg = generated[name];
		assert.ok(pkg, `missing generated package: ${name}`);
		assert.deepEqual(pkg.os, [expected.os], `${name}: os must be ${expected.os} (npm matches process.platform)`);
		assert.deepEqual(pkg.cpu, [expected.cpu], `${name}: cpu must be ${expected.cpu} (npm matches process.arch)`);
	}
});

test('generated package names exactly match the main package optionalDependencies', () => {
	const generatedNames = Object.keys(generated)
		.map((n) => `${PACKAGE_NAME}-${n}`)
		.sort();
	const declared = Object.keys(mainPkg.optionalDependencies).sort();
	assert.deepEqual(generatedNames, declared);
});

test('all platform packages are pinned to the main package version', () => {
	for (const [name, pkg] of Object.entries(generated)) {
		assert.equal(pkg.version, mainPkg.version, `${name} version should equal main package version ${mainPkg.version}`);
	}
	for (const [dep, range] of Object.entries(mainPkg.optionalDependencies)) {
		assert.equal(range, mainPkg.version, `${dep} should be ${mainPkg.version}`);
	}
});

test('linux packages declare libc glibc; everywhere else the field is absent', () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const pkg = generated[name];
		assert.ok(pkg, `missing generated package: ${name}`);
		if (expected.libc) {
			assert.deepEqual(
				pkg.libc,
				expected.libc,
				`${name}: libc must be ${JSON.stringify(expected.libc)}; without it npm ` +
					`installs the glibc-linked binary on musl and every spawn dies ENOENT`
			);
		} else {
			// On non-Linux the field is meaningless, and npm skips an optional dep
			// whose libc does not match the host, so a stray value here would make
			// the package uninstallable everywhere.
			assert.ok(!('libc' in pkg), `${name}: libc must be absent on non-Linux packages`);
		}
	}
});

test("os/cpu never leak this project's internal platform names", () => {
	// The macos-x86_64 platform package shipped with os "macos" and cpu "x86_64",
	// our own names. npm compares those against process.platform/process.arch
	// ("darwin"/"x64"), so that package could never install anywhere and the
	// optional dependency was skipped in silence, which looks identical to "the
	// platform isn't supported".
	const INTERNAL_NAMES = new Set(['macos', 'windows', 'x86_64']);
	for (const [name, pkg] of Object.entries(generated)) {
		for (const value of [...pkg.os, ...pkg.cpu]) {
			assert.ok(
				!INTERNAL_NAMES.has(value),
				`${name}: "${value}" is this project's internal name, not a Node ` +
					`process.platform/process.arch value; npm would never install this package`
			);
		}
	}
});

/**
 * Load a generated platform package's index.js the way a consumer would.
 * createRequire, because the generated index.js is CommonJS BY CONTRACT: its
 * manifest carries no "type" field, so it stays CJS even though the main
 * package is ESM-only, and loading it through require() proves exactly that.
 */
const requireCjs = createRequire(import.meta.url);
function loadIndex(platformName) {
	const indexPath = path.join(npmDir, platformName, 'index.js');
	assert.ok(fs.existsSync(indexPath), `${platformName}: no index.js was generated`);
	return requireCjs(indexPath);
}

test('every binary has an exported accessor, resolving bin/<binary> inside its own package', () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const index = loadIndex(name);
		const packageDir = path.join(npmDir, name);
		for (const binary of expected.binaries) {
			assert.equal(
				typeof index[binary.accessor],
				'function',
				`${name}: index.js must export ${binary.accessor}(). BinaryManager resolves ` +
					`the ${binary.kind} binary by calling exactly that name, and a package ` +
					`missing it resolves nothing while still installing cleanly`
			);
			const resolved = index[binary.accessor]();
			assert.equal(
				resolved,
				path.join(packageDir, 'bin', binary.file),
				`${name}: ${binary.accessor}() must point at bin/${binary.file}`
			);
			assert.ok(
				path.isAbsolute(resolved),
				`${name}: ${binary.accessor}() must return an absolute path; Harper's ` +
					`allowlist is an exact string match against the absolute command`
			);
		}
	}
});

test('the binaries map enumerates both kinds with their published filenames', () => {
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const index = loadIndex(name);
		assert.deepEqual(
			index.binaries,
			Object.fromEntries(expected.binaries.map((b) => [b.kind, b.file])),
			`${name}: the binaries map is how a consumer enumerates what actually shipped ` +
				`instead of guessing per-platform filenames`
		);
	}
});

test('index.js exports the accessors and the binaries map, and nothing else', () => {
	// A stray or duplicated accessor is the shape a copy-paste regression takes,
	// and it is invisible: the extra export resolves a path that was never copied
	// into bin/.
	for (const [name, expected] of Object.entries(EXPECTED)) {
		const exported = Object.keys(loadIndex(name)).sort();
		const wanted = [...expected.binaries.map((b) => b.accessor), 'binaries'].sort();
		assert.deepEqual(exported, wanted, `${name}: unexpected index.js exports`);
	}
});

test('--dummy generates the package layout with no bin/ at all', () => {
	// --dummy is the only mode CI can run without a Go toolchain, so every
	// assertion above already exercises it; what is specific to it is that the
	// accessors exist while the binaries they point at do not.
	for (const name of Object.keys(EXPECTED)) {
		assert.ok(!fs.existsSync(path.join(npmDir, name, 'bin')));
	}
});

test('every platform package publishes bin/ and index.js', () => {
	for (const [name, pkg] of Object.entries(generated)) {
		for (const entry of ['bin/', 'index.js']) {
			assert.ok(
				pkg.files.includes(entry),
				`${name}: "files" must include ${entry}, or npm publishes a package whose ` +
					`accessors point at paths that are not in the tarball`
			);
		}
	}
});
