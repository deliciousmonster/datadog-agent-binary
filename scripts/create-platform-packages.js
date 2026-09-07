#!/usr/bin/env node

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoVersion, platformPackageDir } from "./paths.js";
import { TARGETS, currentTarget } from "../dist/src/targets.js";
import { BINARIES, binaryFilename } from "../dist/src/binaries.js";
import { buildTree } from "../dist/src/layout.js";

function copyPlatformBinary(platform) {
	const packageDir = platformPackageDir(platform.name);
	mkdirSync(join(packageDir, "bin"), { recursive: true });
	const builtAt = buildTree(REPO_ROOT, platform).bin;

	for (const binary of BINARIES) {
		const fileName = binaryFilename(binary, platform);
		const from = join(builtAt, fileName);
		if (!existsSync(from)) {
			throw new Error(`Binary not found at ${from}`);
		}
		const to = join(packageDir, "bin", fileName);
		copyFileSync(from, to);
		// Ensure the executable bit is set so it survives `npm publish`/`npm install`.
		chmodSync(to, 0o755);
	}
}

const version = readRepoVersion();

const lastArg = process.argv[process.argv.length - 1];
const platforms = lastArg === "--all" ? TARGETS : [currentTarget()];

const packageTemplate = {
	version: version,
	description: "",
	main: "index.js",
	repository: {
		type: "git",
		url: "https://github.com/deliciousmonster/datadog-agent-binary.git",
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
		name: `@deliciousmonster/datadog-agent-binary-${platform.name}`,
		description: `Datadog Agent binary for ${os} ${arch}`,
		os: [platform.npmOs],
		cpu: [platform.npmCpu],
		keywords: [...packageTemplate.keywords, os, arch],
	};

	writeFileSync(
		join(platformPackageDir(platform.name), "package.json"),
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
	writeFileSync(
		join(platformPackageDir(platform.name), "index.js"),
		indexContent
	);
}

function writePlatformReadme(platform) {
	const name = `@deliciousmonster/datadog-agent-binary-${platform.name}`;
	const os = platform.os;
	const arch = platform.arch;
	const readme = `# ${name}

Pre-built Datadog Agent binary for **${os} ${arch}**.

This is a platform-specific companion package for
[\`@deliciousmonster/datadog-agent-binary\`](https://www.npmjs.com/package/@deliciousmonster/datadog-agent-binary).
You should **not** install it directly — install the main package instead, and
npm will automatically select the correct binary for your OS and CPU via
\`optionalDependencies\`:

\`\`\`bash
npm install @deliciousmonster/datadog-agent-binary
\`\`\`

The main package resolves the binary shipped here at runtime. See the
[main package README](https://github.com/deliciousmonster/datadog-agent-binary#readme)
for usage, configuration, and Harper integration details.

## License

Apache-2.0. The Datadog Agent binary is distributed under the Apache-2.0
license per the [Datadog Agent repository](https://github.com/DataDog/datadog-agent).
`;
	writeFileSync(join(platformPackageDir(platform.name), "README.md"), readme);
}

platforms.forEach((platform) => {
	copyPlatformBinary(platform);
	const packageJson = writePlatformPackageJson(platform);
	writePlatformIndexJs(platform);
	writePlatformReadme(platform);
	console.log(`Created package: ${packageJson.name}`);
});

console.log("Platform packages created successfully!");
