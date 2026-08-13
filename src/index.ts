import * as path from "path";
import { DatadogAgentDownloader } from "./downloader.js";
import { createBuilder } from "./builders/index.js";
import { logger } from "./logger.js";
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
		const { mkdir, symlink, stat } = await import("fs/promises");

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
			} catch (error: any) {
				logger.error(`Failed to create symlink: ${error.message}`);
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

export * from "./types.js";
export * from "./platform.js";
export * from "./downloader.js";
export * from "./builders/index.js";
export * from "./logger.js";
export * from "./binary-manager.js";
