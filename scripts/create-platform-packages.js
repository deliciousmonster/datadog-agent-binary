#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { argv } from 'node:process';
import { SUPPORTED_PLATFORMS, Platform } from '../dist/platform.js';

// Platform sub-packages are named `<this package>-<platform>`. Deriving the prefix
// from the manifest keeps packaging and runtime resolution in agreement and makes
// re-scoping a one-line edit.
const parentPackageJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
const PACKAGE_NAME = parentPackageJson.name;
if (!PACKAGE_NAME) {
	throw new Error('package.json has no `name`; cannot derive package names.');
}
const version = parentPackageJson.version;

function getPackageDir(platform) {
	return path.join(import.meta.dirname, '..', 'npm', platform.getName());
}

/**
 * Two descriptors sharing an accessorName collapse into one property in the
 * generated index.js; two sharing an outputName overwrite each other in bin/.
 * Both look like "the trace-agent is missing" at runtime, so fail here instead.
 */
function getDescriptors(platform) {
	const descriptors = platform.getBinaries();
	const seen = new Map();
	for (const descriptor of descriptors) {
		for (const field of ['accessorName', 'outputName']) {
			const key = `${field}:${descriptor[field]}`;
			const owner = seen.get(key);
			if (owner) {
				throw new Error(
					`${platform.getName()}: binaries "${owner}" and "${descriptor.kind}" ` +
						`share ${field} "${descriptor[field]}"`
				);
			}
			seen.set(key, descriptor.kind);
		}
	}
	return descriptors;
}

function copyPlatformBinaries(platform) {
	const buildBinDir = path.join(import.meta.dirname, '..', 'build', platform.getName(), 'bin');
	const resolved = getDescriptors(platform).map((descriptor) => ({
		descriptor,
		sourcePath: path.join(buildBinDir, descriptor.outputName),
	}));

	// Check every binary before copying any. A package holding the core agent but
	// not the trace-agent installs and resolves, then getTraceAgentBinaryPath()
	// hands back a path to a file that does not exist, so the failure surfaces as
	// an unexplained ENOENT at spawn time instead of here.
	const missing = resolved.filter((r) => !fs.existsSync(r.sourcePath));
	if (missing.length > 0) {
		const detail = missing.map((r) => `${r.descriptor.kind} (${r.sourcePath})`).join(', ');
		throw new Error(`missing binaries: ${detail}`);
	}

	const binDir = path.join(getPackageDir(platform), 'bin');
	fs.mkdirSync(binDir, { recursive: true });
	for (const { descriptor, sourcePath } of resolved) {
		const destPath = path.join(binDir, descriptor.outputName);
		fs.copyFileSync(sourcePath, destPath);
		// The executable bit has to survive `npm publish`/`npm install`.
		fs.chmodSync(destPath, 0o755);
	}
}

// npm filters optionalDependencies using Node's `process.platform` and
// `process.arch` values, NOT our human-readable names. Map to those so the
// right binary package actually installs on each host.
const NPM_OS = { linux: 'linux', macos: 'darwin', windows: 'win32' };
const NPM_CPU = { x86_64: 'x64', arm64: 'arm64' };

function npmValue(table, key, field) {
	const mapped = table[key];
	if (!mapped) throw new Error(`No npm ${field} mapping for "${key}"`);
	return mapped;
}

const NODE_FIELDS = [
	['os', 'platform', new Set(Object.values(NPM_OS))],
	['cpu', 'arch', new Set(Object.values(NPM_CPU))],
];

/**
 * The macos-x86_64 platform package was published with os/cpu "macos"/"x86_64",
 * our internal names. npm compares those against process.platform/process.arch,
 * which are "darwin"/"x64", so the package could never install anywhere and the
 * optional dependency was silently skipped. The mapping above is right; this
 * guard exists so a future edit that bypasses it fails the release instead of
 * shipping another uninstallable package.
 */
function assertNodeOSAndCPU(packageJson) {
	for (const [field, nodeField, allowed] of NODE_FIELDS) {
		for (const value of packageJson[field]) {
			if (!allowed.has(value)) {
				throw new Error(
					`${packageJson.name}: ${field} "${value}" is not a Node ` +
						`process.${nodeField} value (expected one of ` +
						`${[...allowed].join(', ')}); npm would never install this package`
				);
			}
		}
	}
}

let platforms;
let createDummyPackages = false;
const lastArg = argv[argv.length - 1];
switch (lastArg) {
	case '--all':
		platforms = SUPPORTED_PLATFORMS;
		break;
	case '--dummy':
		platforms = SUPPORTED_PLATFORMS;
		createDummyPackages = true;
		break;
	default:
		platforms = [Platform.current()];
}

const packageTemplate = {
	version,
	description: '',
	main: 'index.js',
	// Inherited, never hardcoded: npm publish --provenance verifies this against
	// the building repo per package, platform packages publish first, and the
	// release preflight only reads the root manifest.
	repository: parentPackageJson.repository,
	keywords: ['datadog', 'agent', 'binary'],
	author: 'Harper',
	license: 'Apache-2.0',
	files: ['bin/', 'index.js', 'README.md'],
};

/** Escape for a single-quoted literal in the generated CommonJS index.js. */
function jsString(value) {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// One accessor per descriptor, so shipping another sub-agent is a change to
// getBinaries() alone. The previous template hardcoded a single accessor and was
// filled in with replace("BINARY_NAME", name), which substitutes only the first
// occurrence, so it could not grow a second binary.
//
// The generated index.js stays CommonJS on purpose, even though this package is now
// ESM-only: the platform manifests written below carry no "type" field, so their
// index.js is CJS by Node's rules, and the main package loads it via `await import()`
// with a default-interop fallback. Emitting ESM here would require republishing every
// platform package in lockstep for zero consumer-visible gain.
function renderIndexJs(platform) {
	const descriptors = getDescriptors(platform);
	const accessors = descriptors.map(
		(d) => `  ${d.accessorName}() {\n` + `    return path.join(__dirname, 'bin', ${jsString(d.outputName)});\n` + `  }`
	);
	const binaryMap = descriptors.map((d) => `    ${d.kind}: ${jsString(d.outputName)}`);

	return (
		`const path = require('path');\n` +
		`\n` +
		`module.exports = {\n` +
		`${accessors.join(',\n')},\n` +
		`  // Filenames in bin/ keyed by kind, so consumers and tests can enumerate\n` +
		`  // what shipped instead of guessing per-platform names.\n` +
		`  binaries: {\n` +
		`${binaryMap.join(',\n')}\n` +
		`  }\n` +
		`};\n`
	);
}

function writePlatformPackageJson(platform) {
	const os = platform.getOS();
	const arch = platform.getArch();
	const packageJson = {
		...packageTemplate,
		name: `${PACKAGE_NAME}-${platform.getName()}`,
		description: `Datadog Agent and trace-agent binaries for ${os} ${arch}`,
		os: [npmValue(NPM_OS, os, 'os')],
		cpu: [npmValue(NPM_CPU, arch, 'cpu')],
		keywords: [...packageTemplate.keywords, 'apm', 'trace-agent', os, arch],
	};

	// CGO_ENABLED=1 links glibc, so on musl (Alpine) the binary dies with an
	// unexplained ENOENT at spawn. Declaring libc makes npm skip the optional
	// dependency there, and the consumer gets the "no packaged binary" path
	// instead of a binary that cannot run.
	if (packageJson.os[0] === 'linux') {
		packageJson.libc = ['glibc'];
	}

	// The only place a platform package.json is written, so this covers every mode.
	assertNodeOSAndCPU(packageJson);

	fs.writeFileSync(path.join(getPackageDir(platform), 'package.json'), JSON.stringify(packageJson, null, '\t') + '\n');

	return packageJson;
}

function writePlatformIndexJs(platform) {
	fs.writeFileSync(path.join(getPackageDir(platform), 'index.js'), renderIndexJs(platform));
}

function writePlatformReadme(platform) {
	const name = `${PACKAGE_NAME}-${platform.getName()}`;
	const os = platform.getOS();
	const arch = platform.getArch();
	const binaryList = getDescriptors(platform)
		.map((d) => `- \`${d.outputName}\`, resolved by \`${d.accessorName}()\``)
		.join('\n');
	const readme = `# ${name}

Pre-built Datadog Agent binaries for **${os} ${arch}**:

${binaryList}

The core agent collects metrics and logs; the trace-agent is the APM receiver
that binds \`127.0.0.1:8126\` and accepts spans from \`dd-trace\`. Both must be
running for tracing to work.

This is a platform-specific companion package for
[\`${PACKAGE_NAME}\`](https://www.npmjs.com/package/${PACKAGE_NAME}).
Do **not** install it directly. Install the main package, and npm will select
the correct binaries for your OS and CPU via \`optionalDependencies\`:

\`\`\`bash
npm install ${PACKAGE_NAME}
\`\`\`

The main package resolves the binaries shipped here at runtime. See the
[main package README](https://github.com/HarperFast/datadog-agent-binary#readme)
for usage, configuration, and Harper integration details.

## License

Apache-2.0. The Datadog Agent binaries are distributed under the Apache-2.0
license per the [Datadog Agent repository](https://github.com/DataDog/datadog-agent).
`;
	fs.writeFileSync(path.join(getPackageDir(platform), 'README.md'), readme);
}

// In --all mode (release), a platform whose binaries did not build is skipped with
// a warning rather than aborting the whole release. Single-platform and --dummy
// modes still fail hard.
const tolerateMissing = lastArg === '--all';

platforms.forEach((platform) => {
	fs.mkdirSync(getPackageDir(platform), { recursive: true });
	if (!createDummyPackages) {
		try {
			copyPlatformBinaries(platform);
		} catch (err) {
			if (!tolerateMissing) throw err;
			// Delete the whole package dir, do not just skip writing to it. The
			// release workflow publishes any npm/<platform>/ whose bin/ is non-empty,
			// so leftovers from an earlier run would go out as a package that
			// resolves but cannot spawn what it claims to ship.
			fs.rmSync(getPackageDir(platform), { recursive: true, force: true });
			console.warn(`Skipping ${platform.getName()}: ${err.message}`);
			return;
		}
	}
	const packageJson = writePlatformPackageJson(platform);
	writePlatformIndexJs(platform);
	writePlatformReadme(platform);
	console.log(
		`Created package: ${packageJson.name} ` +
			`(${getDescriptors(platform)
				.map((d) => d.outputName)
				.join(', ')})`
	);
});
