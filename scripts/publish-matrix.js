#!/usr/bin/env node

/**
 * Print and verify the per-platform package matrix. See --help for the modes.
 *
 * Each defect this project shipped was one wrong field in metadata the registry
 * stores and npmjs.com does not render:
 *
 *   - macos-x86_64 published with os "macos" / cpu "x86_64". npm compares those
 *     against process.platform / process.arch ("darwin" / "x64"), so the package
 *     could never install.
 *   - macos-x86_64 declared in optionalDependencies while no CI leg built it:
 *     five declared, four published.
 *   - Every package shipped the core agent alone, so nothing bound 127.0.0.1:8126
 *     and every span was dropped.
 *
 * optionalDependencies failures are silent, so all three reached consumers as no
 * binaries and no error. This exits non-zero instead.
 *
 * Run --local BEFORE `npm publish`: it is the last moment the answer can change
 * anything, since a published version can be deprecated but never replaced. Run
 * --registry after, and on a schedule, since packages can be unpublished later.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { SUPPORTED_PLATFORMS } from '../dist/platform.js';
import { isCliEntry } from './cli-entry.js';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const mainPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// The generator and the runtime both derive platform package names from the main
// package name, so this must too, or a re-scope leaves the checker validating the
// wrong namespace.
export const PACKAGE_NAME = mainPkg.name;
export const PACKAGE_VERSION = mainPkg.version;

// npm matches os/cpu against process.platform / process.arch. Anything outside
// these sets, our own "macos"/"windows"/"x86_64" included, can never install.
const NODE_OS = new Set(['linux', 'darwin', 'win32']);
const NODE_CPU = new Set(['x64', 'arm64']);
const NODE_FIELDS = [
	['os', 'platform', NODE_OS],
	['cpu', 'arch', NODE_CPU],
];

function parseArgs(argv) {
	const opts = {
		mode: 'local',
		dir: path.join(REPO_ROOT, 'npm'),
		version: PACKAGE_VERSION,
		deep: false,
		format: 'text',
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--local') {
			opts.mode = 'local';
			if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.dir = argv[++i];
		} else if (arg === '--registry') {
			opts.mode = 'registry';
			if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.version = argv[++i];
		} else if (arg === '--deep') {
			opts.deep = true;
		} else if (arg === '--markdown') {
			opts.format = 'markdown';
		} else if (arg === '--json') {
			opts.format = 'json';
		} else if (arg === '--help' || arg === '-h') {
			opts.help = true;
		}
	}
	return opts;
}

/** Platform package names this project is supposed to publish. */
export function expectedPackages() {
	return SUPPORTED_PLATFORMS.map((platform) => ({
		platform: platform.getName(),
		name: `${PACKAGE_NAME}-${platform.getName()}`,
		// From the same descriptors the build and runtime use; a hand-written list
		// would let a descriptor change pass unnoticed.
		binaries: platform.getBinaries().map((b) => b.outputName),
	}));
}

export function readLocal(expected, dir) {
	const packageDir = path.join(dir, expected.platform);
	const manifestPath = path.join(packageDir, 'package.json');
	if (!fs.existsSync(manifestPath)) {
		return { ...expected, present: false, source: packageDir };
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const binDir = path.join(packageDir, 'bin');
	const files = fs.existsSync(binDir) ? fs.readdirSync(binDir).sort() : [];
	const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(binDir, f)).size, 0);
	return {
		...expected,
		present: true,
		source: packageDir,
		version: manifest.version,
		os: manifest.os ?? [],
		cpu: manifest.cpu ?? [],
		files,
		bytes,
		// --dummy packages legitimately carry no binaries; record it and let the
		// caller decide whether that is acceptable.
		dummy: files.length === 0,
	};
}

const REGISTRY = process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org';

const RETRY_DELAY_MS = 5000;

/**
 * Fetch a package document, retrying while it is absent.
 *
 * Publishing is not read-your-writes: a fetch immediately after `npm publish` can
 * 404 or return stale metadata. Without the retries a post-publish check goes
 * flaky, which is worse than no check because people learn to ignore it.
 */
async function fetchPackument(name, retries) {
	const url = `${REGISTRY}/${name.replace('/', '%2F')}`;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { accept: 'application/json' },
			});
			if (response.ok) return await response.json();
			if (response.status !== 404) {
				throw new Error(`HTTP ${response.status} for ${name}`);
			}
		} catch (error) {
			if (attempt === retries) throw error;
		}
		if (attempt < retries) {
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
		}
	}
	return null;
}

/** Download a tarball and list its `package/bin/` entries. */
async function listTarballBinaries(tarballUrl) {
	const response = await fetch(tarballUrl);
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${tarballUrl}`);
	const gz = Buffer.from(await response.arrayBuffer());
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddab-matrix-'));
	try {
		const tarPath = path.join(tmp, 'pkg.tar');
		fs.writeFileSync(tarPath, zlib.gunzipSync(gz));
		// `tar -t` rather than extracting: >150 MB per platform, and only the entry
		// names matter.
		const listing = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' });
		return listing
			.split('\n')
			.filter((line) => /^package\/bin\/.+/.test(line))
			.map((line) => line.replace('package/bin/', '').trim())
			.filter(Boolean)
			.sort();
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function readRegistry(expected, version, deep, retries) {
	let packument;
	try {
		packument = await fetchPackument(expected.name, retries);
	} catch (error) {
		return { ...expected, present: false, error: error.message };
	}
	const manifest = packument?.versions?.[version];
	if (!manifest) {
		return {
			...expected,
			present: false,
			source: REGISTRY,
			error: packument ? `version ${version} not published` : 'package not found',
		};
	}

	let files = null;
	if (deep) {
		try {
			files = await listTarballBinaries(manifest.dist.tarball);
		} catch (error) {
			expected.deepError = error.message;
		}
	}

	return {
		...expected,
		present: true,
		source: REGISTRY,
		version,
		os: manifest.os ?? [],
		cpu: manifest.cpu ?? [],
		files,
		// The cheap signal without --deep. A package carrying both binaries has 5
		// files (2 binaries + index.js + package.json + README.md); the core-only
		// packages that caused the original defect had 4.
		fileCount: manifest.dist.fileCount,
		bytes: manifest.dist.unpackedSize,
	};
}

export function verify(rows) {
	const problems = [];

	for (const row of rows) {
		const label = row.name;

		if (!row.present) {
			problems.push(
				`${label}: not found (${row.error ?? row.source}). It is declared in ` +
					`optionalDependencies, so npm will skip it silently and the consumer ` +
					`gets no binaries and no error.`
			);
			continue;
		}

		for (const [field, nodeField, allowed] of NODE_FIELDS) {
			for (const value of row[field]) {
				if (!allowed.has(value)) {
					problems.push(
						`${label}: ${field} "${value}" is not a Node process.${nodeField} ` +
							`value (${[...allowed].join(', ')}). npm can never match this package.`
					);
				}
			}
		}

		if (row.version && row.version !== PACKAGE_VERSION) {
			problems.push(
				`${label}: version ${row.version} does not match the main package ` +
					`${PACKAGE_VERSION}. The two are version-locked; a skewed platform ` +
					`package resolves the wrong accessors.`
			);
		}

		if (Array.isArray(row.files) && !row.dummy) {
			for (const required of row.binaries) {
				if (!row.files.includes(required)) {
					problems.push(
						`${label}: missing ${required}. Shipping the core agent without the ` +
							`trace-agent is the defect this package exists to fix: nothing binds ` +
							`127.0.0.1:8126 and every span is dropped in silence.`
					);
				}
			}
		} else if (row.fileCount != null) {
			const expectedCount = row.binaries.length + 3; // + index.js, package.json, README.md
			if (row.fileCount < expectedCount) {
				problems.push(
					`${label}: fileCount ${row.fileCount} is below the ${expectedCount} a ` +
						`package carrying ${row.binaries.join(' + ')} should have. Re-run with ` +
						`--deep to list the tarball contents.`
				);
			}
		}
	}

	// Drift between these two is how a platform ends up declared but never built,
	// or built but never declared.
	const declared = Object.keys(mainPkg.optionalDependencies ?? {}).sort();
	const expectedNames = rows.map((r) => r.name).sort();
	if (JSON.stringify(declared) !== JSON.stringify(expectedNames)) {
		problems.push(
			`optionalDependencies does not match SUPPORTED_PLATFORMS.\n` +
				`  declared: ${declared.join(', ') || '(none)'}\n` +
				`  expected: ${expectedNames.join(', ')}\n` +
				`  Run \`npm run update-optional-deps\`, and make sure every platform here ` +
				`has a leg in build-release.yml.`
		);
	}

	for (const [dep, range] of Object.entries(mainPkg.optionalDependencies ?? {})) {
		if (range !== PACKAGE_VERSION) {
			problems.push(`optionalDependencies["${dep}"] is "${range}", expected exactly ` + `"${PACKAGE_VERSION}".`);
		}
	}

	return problems;
}

function mib(bytes) {
	if (bytes == null) return '-';
	return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function binariesCell(row) {
	if (!row.present) return '-';
	if (row.dummy) return '(dummy)';
	if (Array.isArray(row.files)) return row.files.join(', ') || '(none)';
	return `${row.fileCount} files`;
}

export function renderText(rows) {
	const header = ['PACKAGE', 'VERSION', 'OS', 'CPU', 'BINARIES', 'SIZE'];
	const body = rows.map((r) => [
		r.name,
		r.present ? (r.version ?? '-') : '-',
		r.present ? r.os.join(',') : 'MISSING',
		r.present ? r.cpu.join(',') : '-',
		binariesCell(r),
		mib(r.bytes),
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)));
	const line = (cells) =>
		cells
			.map((c, i) => String(c).padEnd(widths[i]))
			.join('  ')
			.trimEnd();

	const out = [line(header), line(widths.map((w) => '-'.repeat(w)))];
	for (const row of body) out.push(line(row));
	return out.join('\n');
}

export function renderMarkdown(rows) {
	const out = [
		`### Published platform matrix for \`${PACKAGE_NAME}@${PACKAGE_VERSION}\``,
		'',
		'| Package | OS | CPU | Binaries | Size |',
		'|---|---|---|---|---|',
	];
	for (const row of rows) {
		out.push(
			`| \`${row.name}\` | ${row.present ? row.os.join(', ') : '**missing**'} | ` +
				`${row.present ? row.cpu.join(', ') : '-'} | ${binariesCell(row)} | ${mib(row.bytes)} |`
		);
	}
	return out.join('\n');
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(
			[
				'Usage:',
				'  node scripts/publish-matrix.js --local [dir]        verify staged packages (offline)',
				'  node scripts/publish-matrix.js --registry [version] verify what is published',
				'',
				'  --deep       registry mode: download tarballs and list bin/ exactly',
				'  --markdown   emit a GitHub table',
				'  --json       emit raw rows',
			].join('\n')
		);
		return 0;
	}

	const expected = expectedPackages();
	let rows;

	if (opts.mode === 'local') {
		rows = expected.map((e) => readLocal(e, opts.dir));
		console.error(`Reading staged packages from ${opts.dir}\n`);
	} else {
		// Retries only matter right after a publish; a scheduled drift check wants a
		// fast answer instead.
		const retries = process.env.MATRIX_RETRIES ? Number(process.env.MATRIX_RETRIES) : 0;
		console.error(
			`Reading ${REGISTRY} for version ${opts.version}` + `${opts.deep ? ' (deep: downloading tarballs)' : ''}\n`
		);
		rows = [];
		for (const e of expected) {
			rows.push(await readRegistry(e, opts.version, opts.deep, retries));
		}
	}

	if (opts.format === 'json') {
		console.log(JSON.stringify(rows, null, 2));
	} else if (opts.format === 'markdown') {
		console.log(renderMarkdown(rows));
	} else {
		console.log(renderText(rows));
	}

	const problems = verify(rows);
	const declaredCount = Object.keys(mainPkg.optionalDependencies ?? {}).length;
	const presentCount = rows.filter((r) => r.present).length;

	console.log('');
	console.log(
		`declared in optionalDependencies: ${declaredCount}    ` +
			`${opts.mode === 'local' ? 'staged' : 'published'}: ${presentCount}    ` +
			`${problems.length === 0 ? 'OK' : `${problems.length} problem(s)`}`
	);

	if (problems.length > 0) {
		console.log('');
		for (const problem of problems) {
			console.log(`::error::${problem}`);
		}
		return 1;
	}
	return 0;
}

// Guarded so tests can import this without the import running the report and
// calling process.exit().
if (isCliEntry(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`publish-matrix failed: ${error?.stack ?? error}`);
			process.exit(1);
		});
}
