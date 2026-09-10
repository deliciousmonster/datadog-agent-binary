import { mkdir, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { build } from "./build.js";
import { extractRelease } from "./extract.js";
import {
	fetchAgentSource,
	fetchLatestVersion,
	pinnedVersion,
} from "./downloader.js";
import { buildTree } from "./layout.js";
import { EBPF_SHIP_DIR } from "./release.js";
import { logger } from "./log.js";
import { Target } from "./targets.js";

export interface BuildRequest {
	readonly target: Target;
	readonly version?: string;
}

// The Go toolchain resolves the agent by import path, so the source has to appear under
// GOPATH/src/github.com/DataDog/datadog-agent rather than wherever it happened to unpack.
async function linkIntoGoPath(
	goPath: string,
	sourceDir: string
): Promise<void> {
	const goSrcDir = join(goPath, "src", "github.com", "DataDog");
	await mkdir(goSrcDir, { recursive: true });
	const link = join(goSrcDir, "datadog-agent");
	await stat(link).catch(() =>
		symlink(relative(goSrcDir, sourceDir), link, "dir")
	);
}

/** Fetches the source, prepares GOPATH, and builds every binary for one target. Throws on failure. */
export async function buildAgents(request: BuildRequest): Promise<string[]> {
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

export * from "./downloader.js";
export * from "./targets.js";
