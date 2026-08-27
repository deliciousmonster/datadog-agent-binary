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
import { SUPPORTED_PLATFORMS, nodeFieldProblems } from '../dist/platform.js';
import { platformPackageName } from '../dist/package-identity.js';
import { runCli } from './cli-entry.js';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const mainPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

// The generator and the runtime both derive platform package names from the main
// package name, so this must too, or a re-scope leaves the checker validating the
// wrong namespace.
export const PACKAGE_NAME = mainPkg.name;
export const PACKAGE_VERSION = mainPkg.version;
const OPTIONAL_DEPS = mainPkg.optionalDependencies ?? {};

function parseArgs(argv) {
	const opts = {
		mode: 'local',
		dir: path.join(REPO_ROOT, 'npm'),
		version: PACKAGE_VERSION,
		deep: false,
		format: 'text',
	};
	for (let i = 0; i < argv.length; i++) {
		// The optional argument to --local/--registry. A following flag is not one.
		const value = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null);
		const arg = argv[i];
		if (arg === '--local') {
			opts.mode = 'local';
			opts.dir = value() ?? opts.dir;
		} else if (arg === '--registry') {
			opts.mode = 'registry';
			opts.version = value() ?? opts.version;
		} else if (arg === '--deep') opts.deep = true;
		else if (arg === '--markdown') opts.format = 'markdown';
		else if (arg === '--json') opts.format = 'json';
		else if (arg === '--help' || arg === '-h') opts.help = true;
	}
	return opts;
}

/** Platform package names this project is supposed to publish. */
export function expectedPackages() {
	return SUPPORTED_PLATFORMS.map((platform) => ({
		platform: platform.getName(),
		name: platformPackageName(platform.getName()),
		// From the same descriptors the build and runtime use; a hand-written list
		// would let a descriptor change pass unnoticed.
		binaries: platform.getBinaries().map((b) => b.outputName),
	}));
}

/** A package that is not where it was expected to be, staged or published. */
function absentRow(expected, source, error) {
	return { ...expected, present: false, source, error };
}

/**
 * The row shape verify() and both renderers read. Shared by the two sources so a
 * field checked in one mode cannot be silently absent in the other.
 */
function presentRow(expected, source, manifest, extra) {
	return {
		...expected,
		present: true,
		source,
		// What the manifest calls itself, which is the name npm publishes under. `name`
		// above is what optionalDependencies asks for; the two are compared, not assumed.
		manifestName: manifest.name,
		version: manifest.version,
		os: manifest.os ?? [],
		cpu: manifest.cpu ?? [],
		...extra,
	};
}

export function readLocal(expected, dir) {
	const packageDir = path.join(dir, expected.platform);
	const manifestPath = path.join(packageDir, 'package.json');
	if (!fs.existsSync(manifestPath)) return absentRow(expected, packageDir);
	const binDir = path.join(packageDir, 'bin');
	const files = fs.existsSync(binDir) ? fs.readdirSync(binDir).sort() : [];
	const sizes = Object.fromEntries(files.map((f) => [f, fs.statSync(path.join(binDir, f)).size]));
	return presentRow(expected, packageDir, JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
		files,
		sizes,
		bytes: Object.values(sizes).reduce((sum, size) => sum + size, 0),
	});
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
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			if (response.ok) return await response.json();
			if (response.status !== 404) throw new Error(`HTTP ${response.status} for ${name}`);
		} catch (error) {
			if (attempt === retries) throw error;
		}
		if (attempt < retries) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
	}
	return null;
}

const JSDELIVR_API = 'https://data.jsdelivr.com/v1/packages/npm';

/**
 * List a published package's `bin/` entries.
 *
 * This used to download the tarball, gunzip it to a temp file and shell out to `tar -tf`:
 * roughly 70 MB per platform, 280 MB per run, to learn four filenames. jsDelivr indexes
 * npm and serves the file tree as JSON, which is the same answer for about 4 KB, with no
 * temp files and no dependency on a system `tar`.
 *
 * It is a derived view rather than the artifact itself, and it indexes on demand, so a
 * just-published version can 404 here briefly. That is deliberately not swallowed: the
 * caller records it and verify() reports it as an unproven release. The authoritative
 * check is `--local`, which reads the staged directory before publish -- the last moment
 * the answer can still change anything.
 */
async function listPublishedBinaries(name, version) {
	const url = `${JSDELIVR_API}/${name}@${version}?structure=flat`;
	const response = await fetch(url, { headers: { accept: 'application/json' } });
	if (!response.ok) throw new Error(`HTTP ${response.status} from jsDelivr for ${name}@${version}`);

	const body = await response.json();
	if (!Array.isArray(body.files)) throw new Error(`jsDelivr returned no file list for ${name}@${version}`);

	const binaries = body.files
		.filter((file) => file.name.startsWith('/bin/'))
		.map((file) => ({ name: file.name.slice('/bin/'.length), size: file.size }))
		.filter((entry) => entry.name)
		.sort((a, b) => a.name.localeCompare(b.name));

	// Every platform package has a bin/. An empty result therefore means the response
	// shape changed, not that the package shipped no binaries -- and the difference
	// matters, because returning [] here would be reported as "missing trace-agent",
	// blaming the release for a defect in this check.
	if (binaries.length === 0) {
		throw new Error(`jsDelivr listed ${body.files.length} files but no bin/ entries for ${name}@${version}`);
	}

	// jsDelivr reports a size per file, so --deep applies the same per-binary floor to a
	// published artifact that --local applies to a staged one.
	return {
		files: binaries.map((entry) => entry.name),
		sizes: Object.fromEntries(binaries.map((entry) => [entry.name, entry.size])),
	};
}

async function readRegistry(expected, version, deep, retries) {
	let packument;
	try {
		packument = await fetchPackument(expected.name, retries);
	} catch (error) {
		return absentRow(expected, REGISTRY, error.message);
	}
	const manifest = packument?.versions?.[version];
	if (!manifest) {
		return absentRow(expected, REGISTRY, packument ? `version ${version} not published` : 'package not found');
	}

	let files = null;
	let sizes;
	if (deep) {
		try {
			({ files, sizes } = await listPublishedBinaries(expected.name, version));
		} catch (error) {
			expected.deepError = error.message;
		}
	}

	return presentRow(expected, REGISTRY, manifest, {
		// The version asked for, not the one the manifest self-reports.
		version,
		files,
		sizes,
		// The cheap signal without --deep. A package carrying both binaries has 5
		// files (2 binaries + index.js + package.json + README.md); the core-only
		// packages that caused the original defect had 4. A registry that reports
		// neither field leaves the row with no evidence at all, which verify() treats
		// as unproven rather than fine.
		fileCount: manifest.dist?.fileCount,
		bytes: manifest.dist?.unpackedSize,
	});
}

/**
 * A Go agent binary is tens of MB, so no real one comes near this floor. It fails only a
 * truncated or placeholder file, which a check on filenames alone passes.
 */
const MIN_BINARY_BYTES = 1024 * 1024;

/**
 * Per-package checks matched to whatever evidence the source can supply, with the absence
 * of evidence a problem in its own right. An empty staged bin/ used to match neither the
 * file-list arm nor the fileCount arm, so the gate printed OK having checked nothing.
 *
 * Do not restore a tolerance for a package carrying no binaries. The `--dummy` stagings
 * that motivated one come from a metadata test that never runs this script, and an empty
 * bin/ here is a build that failed.
 */
function binaryProblems(row, label) {
	const problems = [];

	// A --deep run that could not read the tarball has to say so. The message used to be
	// assigned to row.deepError and read by nothing, so `files` stayed null, the
	// authoritative per-binary check below was skipped, and the gate silently downgraded
	// itself to the fileCount heuristic -- which passes a package whose bin/ holds the
	// wrong files, the exact defect --deep exists to catch.
	if (row.deepError) {
		problems.push(
			`${label}: could not inspect the published tarball (${row.deepError}). ` +
				`Which binaries it contains is unverified, so this release is not proven.`
		);
	}

	if (Array.isArray(row.files)) {
		for (const required of row.binaries.filter((b) => !row.files.includes(b))) {
			problems.push(
				`${label}: missing ${required}. Shipping the core agent without the ` +
					`trace-agent is the defect this package exists to fix: nothing binds ` +
					`127.0.0.1:8126 and every span is dropped in silence.`
			);
		}

		for (const required of row.binaries) {
			// A binary that is absent has no size and was named above; this is the one
			// that is present and empty.
			const size = row.sizes?.[required];
			if (size != null && size < MIN_BINARY_BYTES) {
				problems.push(
					`${label}: ${required} is ${size} bytes, under the ${MIN_BINARY_BYTES} floor. ` +
						`A real agent binary is tens of MB, so this one is truncated or a ` +
						`placeholder, and it satisfies a check that only matches filenames.`
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

		// Five files of any size satisfy the count, so without a floor a tarball holding
		// two empty binaries reads as a real release. Only a total is available here.
		const floor = row.binaries.length * MIN_BINARY_BYTES;
		if (row.bytes != null && row.bytes < floor) {
			problems.push(
				`${label}: ${row.bytes} bytes unpacked cannot hold ${row.binaries.join(' + ')}, ` +
					`which are tens of MB each. Re-run with --deep to list the tarball contents.`
			);
		}
	} else if (!row.deepError) {
		problems.push(
			`${label}: the source reported neither a file list nor a fileCount, so what is ` +
				`in bin/ is unverified. Re-run with --deep.`
		);
	}

	return problems;
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

		// The gate checked every field a past defect had touched and never this one, so a
		// staged directory whose manifest names a different package would publish under that
		// name while optionalDependencies kept asking for this one.
		if (row.manifestName !== row.name) {
			problems.push(
				`${label}: the manifest at ${row.source} calls itself "${row.manifestName}". ` +
					`That is the name it publishes under, while optionalDependencies asks for ` +
					`"${row.name}", so npm resolves nothing and skips the dependency in silence.`
			);
		}

		problems.push(...nodeFieldProblems(row, label));

		if (row.version && row.version !== PACKAGE_VERSION) {
			problems.push(
				`${label}: version ${row.version} does not match the main package ` +
					`${PACKAGE_VERSION}. The two are version-locked; a skewed platform ` +
					`package resolves the wrong accessors.`
			);
		}

		problems.push(...binaryProblems(row, label));
	}

	// Drift between these two is how a platform ends up declared but never built,
	// or built but never declared.
	const declared = Object.keys(OPTIONAL_DEPS).sort();
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

	for (const [dep, range] of Object.entries(OPTIONAL_DEPS).filter(([, r]) => r !== PACKAGE_VERSION)) {
		problems.push(`optionalDependencies["${dep}"] is "${range}", expected exactly "${PACKAGE_VERSION}".`);
	}

	return problems;
}

function mib(bytes) {
	return bytes == null ? '-' : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function binariesCell(row) {
	if (!row.present) return '-';
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
		// One at a time: --deep holds a whole tarball, gzipped and expanded, in memory.
		rows = [];
		for (const e of expected) rows.push(await readRegistry(e, opts.version, opts.deep, retries));
	}

	if (opts.format === 'json') console.log(JSON.stringify(rows, null, 2));
	else if (opts.format === 'markdown') console.log(renderMarkdown(rows));
	else console.log(renderText(rows));

	const problems = verify(rows);
	const declaredCount = Object.keys(OPTIONAL_DEPS).length;
	const presentCount = rows.filter((r) => r.present).length;

	console.log('');
	console.log(
		`declared in optionalDependencies: ${declaredCount}    ` +
			`${opts.mode === 'local' ? 'staged' : 'published'}: ${presentCount}    ` +
			`${problems.length === 0 ? 'OK' : `${problems.length} problem(s)`}`
	);

	if (problems.length > 0) {
		console.log('');
		for (const problem of problems) console.log(`::error::${problem}`);
		return 1;
	}
	return 0;
}

// Guarded so tests can import this without the import running the report.
await runCli(import.meta.url, 'publish-matrix', main);
