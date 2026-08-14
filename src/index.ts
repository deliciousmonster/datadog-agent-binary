import * as path from "node:path";
import { DatadogAgentDownloader } from "./downloader.js";
import { createBuilder } from "./builders/index.js";
import { errorMessage, logger } from "./logger.js";
import { BuildConfig, BuildResult } from "./types.js";
import { Platform } from "./platform.js";

export class DatadogAgentBuilder {
	private downloader: DatadogAgentDownloader;

	constructor() {
		this.downloader = new DatadogAgentDownloader();
	}

	getLatestVersion(): Promise<string> {
		return this.downloader.getLatestVersion();
	}

	async buildForPlatform(
		platform: Platform,
		options: {
			version?: string;
			outputDir?: string;
			buildArgs?: string[];
		} = {}
	): Promise<BuildResult> {
		// Both binaries come from this one ref: the core agent and trace-agent share an
		// IPC auth handshake and a config schema, so a mismatched pair fails at the
		// handshake with nothing in the error naming the cause. resolveVersion falls back
		// to the pin in .datadog-agent-version, never to upstream "latest", and proves the
		// tag exists before we clone.
		const version = await this.downloader.resolveVersion(options.version);
		const platformName = platform.getName();
		const outputDir = options.outputDir || "./build";

		const platformBuildDir = path.join(process.cwd(), "build", platformName);
		const sourceDir = path.join(platformBuildDir, "src");
		const platformGoPath = path.join(platformBuildDir, "go");

		logger.info(`Building Datadog Agent ${version} for ${platformName}`);

		await this.downloader.downloadSource({
			version,
			platform,
			extractTo: sourceDir,
		});

		await this.setupGoPathStructure(platformGoPath, sourceDir);

		await this.downloader.checkBuildDependencies(platform);

		const config: BuildConfig = {
			platform,
			version,
			outputDir,
			sourceDir,
			buildArgs: options.buildArgs,
		};

		const builder = createBuilder(config);
		return await builder.build();
	}

	private async setupGoPathStructure(
		goPath: string,
		sourceDir: string
	): Promise<void> {
		const { mkdir, symlink, stat } = await import("node:fs/promises");

		const goSrcDir = path.join(goPath, "src", "github.com", "DataDog");
		await mkdir(goSrcDir, { recursive: true });

		const symlinkPath = path.join(goSrcDir, "datadog-agent");
		const relativePath = path.relative(goSrcDir, sourceDir);

		try {
			await stat(symlinkPath);
			logger.debug(`GOPATH symlink already exists: ${symlinkPath}`);
		} catch {
			try {
				await symlink(relativePath, symlinkPath, "dir");
				logger.debug(
					`Created GOPATH symlink: ${symlinkPath} -> ${relativePath}`
				);
			} catch (error) {
				logger.error(`Failed to create symlink: ${errorMessage(error)}`);
				throw error;
			}
		}
	}

	async buildForCurrentPlatform(
		options: {
			version?: string;
			outputDir?: string;
			sourceDir?: string;
			buildArgs?: string[];
		} = {}
	): Promise<BuildResult> {
		const platform = Platform.current();
		return await this.buildForPlatform(platform, options);
	}
}

// The named public API, instead of six export *. Everything else (the launcher,
// the logger, the per-OS builder classes, SUPPORTED_PLATFORMS) is reached through
// its own module by the scripts and shims that need it, and a wildcard here would
// silently promote every future internal helper to public surface.
export { BinaryManager } from "./binary-manager.js";
export { DatadogAgentDownloader } from "./downloader.js";
export { createBuilder } from "./builders/index.js";
export { Platform } from "./platform.js";
export type {
	AgentBinaryDescriptor,
	AgentBinaryKind,
	Architecture,
	BuildConfig,
	BuildResult,
	DownloadConfig,
	Logger,
	OS,
} from "./types.js";
