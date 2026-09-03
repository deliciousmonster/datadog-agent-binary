import { mkdir, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { build } from "./build.js";
import {
	fetchAgentSource,
	fetchLatestVersion,
	pinnedVersion,
} from "./downloader.js";
import { logger } from "./logger.js";
import { currentTarget, Target } from "./targets.js";

export interface BuildRequest {
	readonly target?: Target;
	readonly version?: string;
	readonly outputDir?: string;
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
export async function buildAgents(
	request: BuildRequest = {}
): Promise<string[]> {
	const { target = currentTarget(), version, outputDir = "./build" } = request;
	const resolved =
		version ?? (await pinnedVersion()) ?? (await fetchLatestVersion());
	const buildDir = join(process.cwd(), "build", target.name);
	const sourceDir = join(buildDir, "src");

	logger.info(`Building Datadog Agent ${resolved} for ${target.name}`);
	await fetchAgentSource(resolved, sourceDir);
	await linkIntoGoPath(join(buildDir, "go"), sourceDir);

	return build({ target, sourceDir, outputDir });
}

export * from "./binaries.js";
export * from "./build.js";
export * from "./downloader.js";
export * from "./logger.js";
export * from "./targets.js";
