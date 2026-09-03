#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const fs = require("fs");
const path = require("path");
const { argv } = require("process");
const { TARGETS, currentTarget } = require("../dist/src/targets.js");
const { BINARIES, binaryFilename } = require("../dist/src/binaries.js");

function getParentVersion() {
	const parentPackageJson = JSON.parse(
		fs.readFileSync(
			path.join(import.meta.dirname, "..", "package.json"),
			"utf8"
		)
	);
	return parentPackageJson.version;
}

function getPackageDir(platform) {
	const platformName = platform.name;
	return path.join(import.meta.dirname, "..", "npm", platformName);
}

function copyPlatformBinary(platform) {
	const packageDir = getPackageDir(platform);
	fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });

	for (const binary of BINARIES) {
		const fileName = binaryFilename(binary, platform);
		const from = path.join(
			import.meta.dirname,
			"..",
			"build",
			platform.name,
			"bin",
			fileName
		);
		if (!fs.existsSync(from)) {
			throw new Error(`Binary not found at ${from}`);
		}
		const to = path.join(packageDir, "bin", fileName);
		fs.copyFileSync(from, to);
		// Ensure the executable bit is set so it survives `npm publish`/`npm install`.
		fs.chmodSync(to, 0o755);
	}
}

// npm filters optionalDependencies using Node's `process.platform` and
// `process.arch` values, NOT our human-readable names. Map to those so the
// right binary package actually installs on each host.
const NPM_OS = { linux: "linux", macos: "darwin", windows: "win32" };
const NPM_CPU = { x86_64: "x64", arm64: "arm64" };

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

const version = getParentVersion();

const lastArg = argv[argv.length - 1];
const platforms = lastArg === "--all" ? TARGETS : [currentTarget()];

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

const indexTemplate = `const path = require('path');

const BINARIES = __BINARIES__;

module.exports = {
  getBinaryPath(name = '__DEFAULT__') {
    const file = BINARIES[name];
    if (!file) throw new Error(\`Unknown binary: \${name}\`);
    return path.join(__dirname, 'bin', file);
  }
};`;

function writePlatformPackageJson(platform) {
	const os = platform.os;
	const arch = platform.arch;
	const packageJson = {
		...packageTemplate,
		name: `@harperfast/datadog-agent-binary-${platform.name}`,
		description: `Datadog Agent binary for ${os} ${arch}`,
		os: [npmOS(os)],
		cpu: [npmCPU(arch)],
		keywords: [...packageTemplate.keywords, os, arch],
	};

	fs.writeFileSync(
		path.join(getPackageDir(platform), "package.json"),
		JSON.stringify(packageJson, null, "\t")
	);

	return packageJson;
}

function writePlatformIndexJs(platform) {
	const files = Object.fromEntries(
		BINARIES.map((b) => [b.shipsAs, binaryFilename(b, platform)])
	);
	const indexContent = indexTemplate
		.replace("__BINARIES__", JSON.stringify(files, null, 2))
		.replace("__DEFAULT__", BINARIES[0].shipsAs);
	fs.writeFileSync(
		path.join(getPackageDir(platform), "index.js"),
		indexContent
	);
}

function writePlatformReadme(platform) {
	const name = `@harperfast/datadog-agent-binary-${platform.name}`;
	const os = platform.os;
	const arch = platform.arch;
	const readme = `# ${name}

Pre-built Datadog Agent binary for **${os} ${arch}**.

This is a platform-specific companion package for
[\`@harperfast/datadog-agent-binary\`](https://www.npmjs.com/package/@harperfast/datadog-agent-binary).
You should **not** install it directly — install the main package instead, and
npm will automatically select the correct binary for your OS and CPU via
\`optionalDependencies\`:

\`\`\`bash
npm install @harperfast/datadog-agent-binary
\`\`\`

The main package resolves the binary shipped here at runtime. See the
[main package README](https://github.com/HarperFast/datadog-agent-binary#readme)
for usage, configuration, and Harper integration details.

## License

Apache-2.0. The Datadog Agent binary is distributed under the Apache-2.0
license per the [Datadog Agent repository](https://github.com/DataDog/datadog-agent).
`;
	fs.writeFileSync(path.join(getPackageDir(platform), "README.md"), readme);
}

// In --all mode (release), tolerate a platform whose binary didn't build: skip it with a warning
// so the platforms that did build still publish. Single-platform mode fails hard instead.
const tolerateMissing = lastArg === "--all";

platforms.forEach((platform) => {
	try {
		copyPlatformBinary(platform);
	} catch (err) {
		if (tolerateMissing) {
			console.warn(`Skipping ${platform.name}: ${err.message}`);
			return;
		}
		throw err;
	}
	const packageJson = writePlatformPackageJson(platform);
	writePlatformIndexJs(platform);
	writePlatformReadme(platform);
	console.log(`Created package: ${packageJson.name}`);
});

console.log("Platform packages created successfully!");
