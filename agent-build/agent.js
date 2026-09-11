// @ts-check
import { mkdir, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { build } from "./compile.js";
import { extractRelease } from "./extract.js";
import {
	fetchAgentSource,
	fetchLatestVersion,
	pinnedVersion,
} from "./download.js";
import { buildTree } from "./layout.js";
import { EBPF_SHIP_DIR } from "./release.js";
import { logger } from "./log.js";
/**
 * @typedef {object} BuildRequest
 * @property {import("./toolchain.js").Target} target
 * @property {string} [version]
 */

// The Go toolchain resolves the agent by import path, so the source has to appear under
// GOPATH/src/github.com/DataDog/datadog-agent rather than wherever it happened to unpack.
/** @param {string} goPath @param {string} sourceDir @returns {Promise<void>} */
async function linkIntoGoPath(goPath, sourceDir) {
	const goSrcDir = join(goPath, "src", "github.com", "DataDog");
	await mkdir(goSrcDir, { recursive: true });
	const link = join(goSrcDir, "datadog-agent");
	await stat(link).catch(() =>
		symlink(relative(goSrcDir, sourceDir), link, "dir")
	);
}

/** Fetches the source, prepares GOPATH, and builds every binary for one target. Throws on failure. */
/** @param {BuildRequest} request @returns {Promise<string[]>} */
export async function buildAgents(request) {
	const { target, version } = request;
	const resolved =
		version ?? (await pinnedVersion()) ?? (await fetchLatestVersion());
	const tree = buildTree(process.cwd(), target);

	logger.info(`Building Datadog Agent ${resolved} for ${target.name}`);
	await fetchAgentSource(resolved, tree.source);
	await linkIntoGoPath(tree.goPath, tree.source);

	const built = await build({
		target,
		sourceDir: tree.source,
		outputDir: tree.bin,
	});
	// Into the same `bin/`, so the packaging step reads one directory and never has to know which half a
	// binary came from. What it does have to know is `from`, which is how the two are split across packages.
	const lifted = await extractRelease({
		target,
		outputDir: tree.bin,
		// Beside `bin/`, not inside it, and at the same relative path the platform package uses. The build
		// tree and the package it is copied into are then the same shape, so the packaging step copies
		// rather than rearranges.
		ebpfDir: join(tree.root, EBPF_SHIP_DIR),
		workDir: tree.extract,
	});
	return [...built, ...lifted];
}

export * from "./download.js";
export * from "./toolchain.js";
