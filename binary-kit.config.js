// @ts-check
// What this package publishes, declared once.
//
// Read by `harper-binary-kit stage`, `verify`, `floor`, `deps`, `names`, `publish` and `latest`, which is the
// point: the package list, the CI matrix, the optionalDependencies and the symbol floors used to be four
// statements of one fact in four files, and a target that silently failed to build was a package that was
// silently not published.
//
// What is NOT here is how to build. That is agent-build/, because only this repo knows that half: two of the
// five binaries are compiled from Datadog's source and three are lifted out of Datadog's signed .deb.

import {
	BINARIES,
	binariesFor,
	recordedBuildTags,
	sourceOf,
} from "./agent-build/binaries.js";
import { findTarget, TARGETS } from "./agent-build/toolchain.js";
import {
	DATADOG_APT_BASE,
	EBPF_SHIP_DIR,
	RELEASE_ARTIFACTS,
} from "./agent-build/release.js";

export const SCOPE = "@deliciousmonster/datadog-agent-binary";

/**
 * Whether the binary a target ships was built with a tag its `--build-exclude` is there to drop.
 *
 * Go writes the tag set it linked with into the binary's own build info as one comma-separated line, so the
 * exclusion is read off the artifact instead of trusted from the flag the build was asked to use. A binary
 * with no record at all is refused rather than passed: unreadable is not the same as clean, and passing it
 * would approve every artifact whose build info the gate failed to find.
 *
 * @param {Buffer} contents @param {{ shipsAs: string }} binary
 * @returns {string | undefined}
 */
function excludedTagIsAbsent(contents, binary) {
	const declared = BINARIES.find((entry) => entry.shipsAs === binary.shipsAs);
	const forbidden = declared?.forbiddenBuildTag;
	if (!forbidden) return undefined;
	const tags = recordedBuildTags(contents);
	if (tags === null)
		return (
			`carries no Go build-tag record, so the "${forbidden}" exclusion cannot be read off the packed ` +
			"binary"
		);
	if (tags.includes(forbidden))
		return `was compiled with the "${forbidden}" build tag, which mandatoryArgs' --build-exclude drops`;
	return undefined;
}

/** `a`, `a and b`, `a, b and c`. */
const listing = (/** @type {readonly string[]} */ names) =>
	names.length < 2
		? names.join("")
		: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Which binaries were compiled here and which were lifted, naming the release each came from.
 *
 * Anyone who installs this runs these binaries on their own machines, so how each one got here is theirs to
 * know. A build and an extraction have different things that can go wrong with them, and a reader who cannot
 * tell which is which cannot reason about either.
 *
 * @param {any} pkg
 */
function provenance(pkg) {
	const target = findTarget(pkg.target.name);
	const artifact = RELEASE_ARTIFACTS[target.name];
	const carried = pkg.binaries.map((binary) => binary.shipsAs);
	const mine = (/** @type {"build" | "release"} */ from) =>
		binariesFor(target)
			.filter(
				(binary) =>
					carried.includes(binary.shipsAs) && sourceOf(binary, target) === from
			)
			.map((binary) => `\`${binary.shipsAs}\``);
	const built = mine("build");
	const lifted = mine("release");
	const were = (/** @type {string[]} */ list) =>
		list.length > 1 ? "were" : "was";
	const lines = [];
	if (built.length > 0) {
		lines.push(
			`${listing(built)} ${were(built)} compiled from the pinned release of ` +
				"[datadog-agent](https://github.com/DataDog/datadog-agent), with the embedded Python runtime " +
				"excluded, then stripped."
		);
	}
	if (lifted.length > 0 && artifact) {
		const objects = pkg.extraDirs.length
			? ", and the precompiled eBPF objects beside them,"
			: "";
		lines.push(
			`${listing(lifted)}${objects} ${were(lifted)} lifted from Datadog's own ` +
				`\`${artifact.path.split("/").pop()}\`, published at ${DATADOG_APT_BASE}. Before anything was ` +
				"unpacked, the build verified that Datadog's APT key signed the repository's `Release` file, " +
				"that `Release` gives the SHA256 of the `Packages` index, that `Packages` gives the SHA256 of " +
				`that .deb, and that the .deb downloaded hashes to the value this repository pins ` +
				`(\`${artifact.sha256}\`).`
		);
	}
	return lines.join("\n\n");
}

/**
 * One line for the manifest. The probe package is named from what it carries rather than from a fixed pair:
 * macOS has no security-agent worth shipping, and a description listing one is a package claiming a binary it
 * does not have.
 *
 * @param {any} pkg
 */
function describe(pkg) {
	const { os, arch } = findTarget(pkg.target.name);
	return pkg.variant.suffix === ""
		? `Datadog core agent and trace-agent for ${os} ${arch}`
		: `Datadog ${listing(pkg.binaries.map((/** @type {{shipsAs: string}} */ binary) => binary.shipsAs))} for ${os} ${arch}`;
}

export default {
	scope: SCOPE,
	// Must match build-release.yml's matrix exactly. A target listed here and never built publishes an
	// optionalDependency npm skips in silence, which is how macos-x86_64 once shipped uninstallable.
	targets: TARGETS.map((target) => target.name),
	variants: [
		{ suffix: "" },
		{
			// Deliberately not an optionalDependency. npm installs one on every host whose os and cpu match,
			// which would charge every install 145 MB for binaries that are privileged and inert until a host
			// is configured for them. An operator who wants them installs this by name.
			suffix: "-probe",
			optional: true,
			carries:
				`It is not a dependency of ${SCOPE}, because it carries system-probe, security-agent and ` +
				"their precompiled eBPF objects and most nodes do not run them.",
			// Only where system-probe is LIFTED, which is Linux: macOS captures packets and Windows uses
			// kernel drivers, so shipping objects to either would be 42 MB neither can load.
			extraDirs: [
				{
					dir: EBPF_SHIP_DIR,
					onlyOn: TARGETS.filter((target) => target.os === "linux").map(
						(target) => target.name
					),
				},
			],
		},
	],
	binaries: BINARIES.map((binary) => ({
		shipsAs: binary.shipsAs,
		...(binary.optional ? { variant: "-probe" } : {}),
		...(binary.onlyOn
			? {
					onlyOn: TARGETS.filter((target) =>
						binary.onlyOn?.includes(target.os)
					).map((target) => target.name),
				}
			: {}),
		symbol: binary.requiredSymbol,
		check: excludedTagIsAbsent,
	})),
	// The Harper Pro runtime image is Debian 12: glibc 2.36 from libc.so.6, GLIBCXX_3.4.30 from GCC 12. Two
	// separate libraries with two separate floors, and a binary over either fails to load at exec time on a
	// customer's node while every test on the runner that built it passes.
	floors: {
		"linux-x86_64": { GLIBC: "2.36", GLIBCXX: "3.4.30" },
		"linux-arm64": { GLIBC: "2.36", GLIBCXX: "3.4.30" },
	},
	manifest: {
		repository: {
			type: "git",
			url: "https://github.com/deliciousmonster/datadog-agent-binary.git",
		},
		keywords: ["datadog", "agent", "binary"],
		author: "Harper",
		license: "Apache-2.0",
	},
	describe,
	/** @param {any} pkg */
	readme: (pkg) => {
		const install = pkg.optionalDependency
			? `Install [${SCOPE}](https://www.npmjs.com/package/${SCOPE}) rather than this one: it
lists this one as an optional dependency and npm picks the one matching the host.

\`\`\`sh
npm install ${SCOPE}
\`\`\``
			: `This one is installed on purpose, not by dependency resolution. \`${SCOPE}\` does not
list it, because system-probe and security-agent do nothing on a node that has not configured them and
this package is ${pkg.extraDirs.length ? "large" : "not small"}. Install it when you want them.

\`\`\`sh
npm install ${SCOPE} ${pkg.name}
\`\`\``;
		return `# ${pkg.name}

${describe(pkg)}, for
[${SCOPE}](https://www.npmjs.com/package/${SCOPE}).

${install}

## Where these binaries came from

${provenance(pkg)}

Apache-2.0. The binaries are Datadog's, Apache-2.0.
`;
	},
};
