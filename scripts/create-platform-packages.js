#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { argv } = require("process");
const { SUPPORTED_PLATFORMS, Platform } = require("../dist/platform.js");

function readParentPackageJson() {
	return JSON.parse(
		fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
	);
}

// Platform sub-packages are named `<this package>-<platform>`. Deriving the prefix
// from the manifest keeps packaging and runtime resolution in agreement and makes
// re-scoping a one-line edit rather than an eleven-file find-and-replace.
function getParentName() {
	const name = readParentPackageJson().name;
	if (!name) {
		throw new Error("package.json has no `name`; cannot derive package names.");
	}
	return name;
}

function getParentVersion() {
	const parentPackageJson = readParentPackageJson();
	return parentPackageJson.version;
}

function getSupportedPlatforms() {
	return SUPPORTED_PLATFORMS;
}

function getCurrentPlatform() {
	return Platform.current();
}

function getPackageDir(platform) {
	const platformName = platform.getName();
	return path.join(__dirname, "..", "npm", platformName);
}

function createPackageDir(platform) {
	const packageDir = getPackageDir(platform);
	fs.mkdirSync(packageDir, { recursive: true });
}

/**
 * Descriptors for every binary this platform ships, with the duplicate checks
 * that the old single-binary code never needed. Two descriptors sharing an
 * accessorName would silently collapse into one property in the generated
 * index.js; two sharing an outputName would have one overwrite the other in
 * bin/. Both failures look like "the trace-agent is missing" at runtime, which
 * is exactly the bug this package is fixing, so fail here instead.
 */
function getDescriptors(platform) {
	const descriptors = platform.getBinaries();
	const seen = new Map();
	for (const descriptor of descriptors) {
		for (const field of ["accessorName", "outputName"]) {
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

/** Where the build step leaves each binary, paired with its descriptor. */
function resolveBuiltBinaries(platform) {
	const buildBinDir = path.join(
		__dirname,
		"..",
		"build",
		platform.getName(),
		"bin"
	);
	return getDescriptors(platform).map((descriptor) => ({
		descriptor,
		sourcePath: path.join(buildBinDir, descriptor.outputName),
	}));
}

function copyPlatformBinaries(platform) {
	const resolved = resolveBuiltBinaries(platform);

	// Check every binary before copying any. A package holding the core agent
	// but not the trace-agent is worse than no package at all: it installs, it
	// resolves, and getTraceAgentBinaryPath() hands back a path to a file that
	// does not exist, so the failure surfaces as an unexplained ENOENT at spawn
	// time instead of here.
	const missing = resolved.filter((r) => !fs.existsSync(r.sourcePath));
	if (missing.length > 0) {
		const detail = missing
			.map((r) => `${r.descriptor.kind} (${r.sourcePath})`)
			.join(", ");
		const label = missing.length === 1 ? "binary" : "binaries";
		throw new Error(`missing ${label} ${detail}`);
	}

	const binDir = path.join(getPackageDir(platform), "bin");
	fs.mkdirSync(binDir, { recursive: true });
	for (const { descriptor, sourcePath } of resolved) {
		const destPath = path.join(binDir, descriptor.outputName);
		fs.copyFileSync(sourcePath, destPath);
		// Ensure the executable bit is set so it survives `npm publish`/`npm install`.
		fs.chmodSync(destPath, 0o755);
	}
}

// npm filters optionalDependencies using Node's `process.platform` and
// `process.arch` values, NOT our human-readable names. Map to those so the
// right binary package actually installs on each host.
const NPM_OS = { linux: "linux", macos: "darwin", windows: "win32" };
const NPM_CPU = { x86_64: "x64", arm64: "arm64" };

const NODE_OS_VALUES = new Set(Object.values(NPM_OS));
const NODE_CPU_VALUES = new Set(Object.values(NPM_CPU));

function npmOS(os) {
	const mapped = NPM_OS[os];
	if (!mapped) throw new Error(`No npm os mapping for "${os}"`);
	return mapped;
}

function npmCPU(arch) {
	const mapped = NPM_CPU[arch];
	if (!mapped) throw new Error(`No npm cpu mapping for "${arch}"`);
	return mapped;
}

/**
 * Last line of defence before a package.json is written.
 *
 * The macos-x86_64 platform package was published with
 * os/cpu "macos"/"x86_64", our internal names. npm compares those fields
 * against process.platform/process.arch, which are "darwin"/"x64", so that
 * package can never install anywhere and the optional dependency is silently
 * skipped. The mapping below is right; this guard exists so a future edit that
 * bypasses it fails the release instead of shipping another uninstallable
 * package.
 */
function assertNodeOSAndCPU(packageJson) {
	for (const value of packageJson.os) {
		if (!NODE_OS_VALUES.has(value)) {
			throw new Error(
				`${packageJson.name}: os "${value}" is not a Node process.platform ` +
					`value (expected one of ${[...NODE_OS_VALUES].join(", ")}); npm ` +
					`would never install this package`
			);
		}
	}
	for (const value of packageJson.cpu) {
		if (!NODE_CPU_VALUES.has(value)) {
			throw new Error(
				`${packageJson.name}: cpu "${value}" is not a Node process.arch ` +
					`value (expected one of ${[...NODE_CPU_VALUES].join(", ")}); npm ` +
					`would never install this package`
			);
		}
	}
}

const version = getParentVersion();
const PACKAGE_NAME = getParentName();

let platforms;
let createDummyPackages = false;
const lastArg = argv[argv.length - 1];
switch (lastArg) {
	case "--all":
		platforms = getSupportedPlatforms();
		break;
	case "--dummy":
		platforms = getSupportedPlatforms();
		createDummyPackages = true;
		break;
	default:
		platforms = [getCurrentPlatform()];
}

const packageTemplate = {
	version: version,
	description: "",
	main: "index.js",
	repository: {
		type: "git",
		url: "https://github.com/HarperFast/datadog-agent-binary.git",
	},
	keywords: ["datadog", "agent", "binary"],
	author: "Harper",
	license: "Apache-2.0",
	files: ["bin/", "index.js", "README.md"],
};

/** Single-quoted JS string literal for the generated CommonJS index.js. */
function jsString(value) {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The previous template hardcoded one accessor and was filled in with
 * String.prototype.replace("BINARY_NAME", name), which substitutes only the
 * first occurrence; the template could not grow a second binary even if
 * someone added the text. Generate one accessor per descriptor instead, so
 * shipping another sub-agent is a change to getBinaries() alone.
 */
function renderIndexJs(platform) {
	const descriptors = getDescriptors(platform);
	const accessors = descriptors.map(
		(d) =>
			`  ${d.accessorName}() {\n` +
			`    return path.join(__dirname, 'bin', ${jsString(d.outputName)});\n` +
			`  }`
	);
	const binaryMap = descriptors.map(
		(d) => `    ${d.kind}: ${jsString(d.outputName)}`
	);

	return (
		`const path = require('path');\n` +
		`\n` +
		`module.exports = {\n` +
		`${accessors.join(",\n")},\n` +
		`  // Filenames of every binary in bin/, keyed by kind, so consumers and\n` +
		`  // tests can enumerate what shipped instead of guessing per-platform names.\n` +
		`  binaries: {\n` +
		`${binaryMap.join(",\n")}\n` +
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
		os: [npmOS(os)],
		cpu: [npmCPU(arch)],
		keywords: [...packageTemplate.keywords, "apm", "trace-agent", os, arch],
	};

	// This is the only place a platform package.json is written, so validating
	// here covers every mode (default, --all, --dummy).
	assertNodeOSAndCPU(packageJson);

	fs.writeFileSync(
		path.join(getPackageDir(platform), "package.json"),
		JSON.stringify(packageJson, null, "\t") + "\n"
	);

	return packageJson;
}

function writePlatformIndexJs(platform) {
	fs.writeFileSync(
		path.join(getPackageDir(platform), "index.js"),
		renderIndexJs(platform)
	);
}

function writePlatformReadme(platform) {
	const name = `${PACKAGE_NAME}-${platform.getName()}`;
	const os = platform.getOS();
	const arch = platform.getArch();
	const binaryList = getDescriptors(platform)
		.map((d) => `- \`${d.outputName}\`, resolved by \`${d.accessorName}()\``)
		.join("\n");
	const readme = `# ${name}

Pre-built Datadog Agent binaries for **${os} ${arch}**:

${binaryList}

The core agent collects metrics and logs; the trace-agent is the APM receiver
that binds \`127.0.0.1:8126\` and accepts spans from \`dd-trace\`. Both must be
running for tracing to work.

This is a platform-specific companion package for
[\`${PACKAGE_NAME}\`](https://www.npmjs.com/package/${PACKAGE_NAME}).
You should **not** install it directly — install the main package instead, and
npm will automatically select the correct binaries for your OS and CPU via
\`optionalDependencies\`:

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
	fs.writeFileSync(path.join(getPackageDir(platform), "README.md"), readme);
}

// In --all mode (release), tolerate a platform whose binaries didn't build:
// skip it with a warning rather than aborting the whole release, so the
// platforms that did build still get published. Single-platform and --dummy
// modes still fail hard, since a missing binary there is unexpected.
const tolerateMissing = lastArg === "--all";

platforms.forEach((platform) => {
	createPackageDir(platform);
	if (!createDummyPackages) {
		try {
			copyPlatformBinaries(platform);
		} catch (err) {
			if (tolerateMissing) {
				// Delete the whole package dir, do not just skip writing to it. The
				// release workflow publishes any npm/<platform>/ whose bin/ is
				// non-empty, so leftovers from an earlier run (or from a platform that
				// built only some of its binaries) would go out as a package that
				// resolves but cannot spawn what it claims to ship.
				fs.rmSync(getPackageDir(platform), { recursive: true, force: true });
				console.warn(`Skipping ${platform.getName()}: ${err.message}`);
				return;
			}
			throw err;
		}
	}
	const packageJson = writePlatformPackageJson(platform);
	writePlatformIndexJs(platform);
	writePlatformReadme(platform);
	console.log(
		`Created package: ${packageJson.name} ` +
			`(${getDescriptors(platform)
				.map((d) => d.outputName)
				.join(", ")})`
	);
});

console.log("Platform packages created successfully!");
