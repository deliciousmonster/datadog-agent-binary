#!/usr/bin/env node

import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	writeFileSync,
	copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoVersion, platformPackageDir } from "./paths.js";
import { TARGETS, currentTarget } from "../dist/src/targets.js";
import { binaryFilename, sourceOf } from "../dist/src/binaries.js";
import { SCOPE, packagesFor } from "../dist/src/packages.js";
import { buildTree } from "../dist/src/layout.js";
import {
	EBPF_SHIP_DIR,
	RELEASE_ARTIFACTS,
	DATADOG_APT_BASE,
} from "../dist/src/release.js";

function copyPlatformBinary(pkg) {
	const packageDir = platformPackageDir(pkg.dirName);
	mkdirSync(join(packageDir, "bin"), { recursive: true });
	const builtAt = buildTree(REPO_ROOT, pkg.target).bin;

	for (const binary of pkg.binaries) {
		const fileName = binaryFilename(binary, pkg.target);
		const from = join(builtAt, fileName);
		if (!existsSync(from)) {
			throw new Error(`Binary not found at ${from}`);
		}
		const to = join(packageDir, "bin", fileName);
		copyFileSync(from, to);
		// Ensure the executable bit is set so it survives `npm publish`/`npm install`.
		chmodSync(to, 0o755);
	}

	// The eBPF objects, when this package carries system-probe. Without them the binary starts, answers
	// `version`, and loads nothing: a feature that is present and does nothing.
	if (pkg.ebpf) {
		const from = join(buildTree(REPO_ROOT, pkg.target).root, EBPF_SHIP_DIR);
		if (!existsSync(from)) {
			throw new Error(
				`${pkg.name} ships system-probe and the eBPF objects are not at ${from}. ` +
					"Run the build, which extracts them from Datadog's signed release."
			);
		}
		cpSync(from, join(packageDir, EBPF_SHIP_DIR), { recursive: true });
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
  }__EXTRAS__
};`;

// system-probe takes the object directory as a config value, so the package that ships them has to be able
// to say where they landed. A consumer that computes the path itself would be computing it from this
// package's layout, which is this package's business to state.
const EBPF_ACCESSOR = `,
  getEbpfDir() {
    return path.join(__dirname, '__EBPF_DIR__');
  }`;

function writePlatformPackageJson(pkg) {
	const { os, arch } = pkg.target;
	const packageJson = {
		...packageTemplate,
		name: pkg.name,
		description: pkg.description,
		os: [pkg.target.npmOs],
		cpu: [pkg.target.npmCpu],
		keywords: [...packageTemplate.keywords, os, arch],
		files: pkg.ebpf
			? [...packageTemplate.files, `${EBPF_SHIP_DIR}/`]
			: packageTemplate.files,
	};

	writeFileSync(
		join(platformPackageDir(pkg.dirName), "package.json"),
		JSON.stringify(packageJson, null, "\t")
	);

	return packageJson;
}

function writePlatformIndexJs(pkg) {
	const files = Object.fromEntries(
		pkg.binaries.map((b) => [b.shipsAs, binaryFilename(b, pkg.target)])
	);
	const indexContent = indexTemplate
		.replace("__BINARIES__", JSON.stringify(files, null, 2))
		.replace("__DEFAULT__", pkg.binaries[0].shipsAs)
		.replace(
			"__EXTRAS__",
			pkg.ebpf ? EBPF_ACCESSOR.replace("__EBPF_DIR__", EBPF_SHIP_DIR) : ""
		);
	writeFileSync(
		join(platformPackageDir(pkg.dirName), "index.js"),
		indexContent
	);
}

/**
 * Says which binaries were compiled here and which were lifted, naming the release each came from.
 *
 * Anyone who installs this is running these binaries on their own machines, so how each one got here is
 * theirs to know rather than ours to keep track of internally. A build and an extraction have different
 * things that can go wrong with them, and a reader who cannot tell which is which cannot reason about
 * either.
 */
function provenance(pkg) {
	const artifact = RELEASE_ARTIFACTS[pkg.target.name];
	const lines = [];
	const built = pkg.binaries.filter((b) => sourceOf(b, pkg.target) === "build");
	const lifted = pkg.binaries.filter(
		(b) => sourceOf(b, pkg.target) === "release"
	);
	if (built.length > 0) {
		lines.push(
			`${list(built)} ${were(built)} compiled from the pinned release of ` +
				"[datadog-agent](https://github.com/DataDog/datadog-agent), with the embedded Python runtime " +
				"excluded, then stripped."
		);
	}
	if (lifted.length > 0 && artifact) {
		lines.push(
			`${list(lifted)}${pkg.ebpf ? ", and the precompiled eBPF objects beside them," : ""} ` +
				`${were(lifted)} lifted from Datadog's own \`${artifact.path.split("/").pop()}\`, ` +
				`published at ${DATADOG_APT_BASE}. Before anything was unpacked, the build verified that ` +
				"Datadog's APT key signed the repository's `Release` file, that `Release` gives the SHA256 " +
				"of the `Packages` index, that `Packages` gives the SHA256 of that .deb, and that the .deb " +
				`downloaded hashes to the value this repository pins (\`${artifact.sha256}\`).`
		);
	}
	return lines.join("\n\n");
}

const list = (binaries) => {
	const names = binaries.map((b) => `\`${b.shipsAs}\``);
	return names.length < 2
		? names.join("")
		: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

const were = (binaries) => (binaries.length > 1 ? "were" : "was");

function writePlatformReadme(pkg) {
	const install = pkg.optionalDependency
		? `Install [${SCOPE}](https://www.npmjs.com/package/${SCOPE}) rather than this one: it
lists this one as an optional dependency and npm picks the one matching the host.

\`\`\`sh
npm install ${SCOPE}
\`\`\``
		: `This one is installed on purpose, not by dependency resolution. \`${SCOPE}\` does not
list it, because system-probe and security-agent do nothing on a node that has not configured them and
this package is ${pkg.ebpf ? "large" : "not small"}. Install it when you want them.

\`\`\`sh
npm install ${SCOPE} ${pkg.name}
\`\`\``;

	const readme = `# ${pkg.name}

${pkg.description}, for
[${SCOPE}](https://www.npmjs.com/package/${SCOPE}).

${install}

## Where these binaries came from

${provenance(pkg)}

Apache-2.0. The binaries are Datadog's, Apache-2.0.
`;
	writeFileSync(join(platformPackageDir(pkg.dirName), "README.md"), readme);
}

platforms.forEach((platform) => {
	for (const pkg of packagesFor(platform)) {
		copyPlatformBinary(pkg);
		const packageJson = writePlatformPackageJson(pkg);
		writePlatformIndexJs(pkg);
		writePlatformReadme(pkg);
		console.log(`Created package: ${packageJson.name}`);
	}
});

console.log("Platform packages created successfully!");
