import { BuildResult } from "../types.js";
import { logger } from "../logger.js";
import { BaseBuilder } from "./base.js";

export class MacOSBuilder extends BaseBuilder {
	async build(): Promise<BuildResult> {
		const startTime = Date.now();
		const { platform } = this.config;

		logger.info(`Building Datadog Agent for macOS ${platform.getArch()}...`);

		try {
			await this.ensureOutputDirectory();
			await this.checkXcodeTools();

			await this.buildCommon();

			logger.info("Copying binaries to output directory...");
			const outputPaths = await this.copyBinariesToOutput();

			const duration = Date.now() - startTime;

			logger.info(`Build completed successfully in ${duration}ms`);
			for (const [kind, binaryPath] of Object.entries(outputPaths)) {
				logger.info(`Output (${kind}): ${binaryPath}`);
			}

			return {
				success: true,
				platform,
				// Core path stays on `outputPath` for existing callers; `outputPaths`
				// carries every binary the build produced.
				outputPath: outputPaths.core,
				outputPaths,
				duration,
			};
		} catch (error: any) {
			const duration = Date.now() - startTime;
			logger.error(`Build failed: ${error.message}`);

			return {
				success: false,
				platform,
				error: error.message,
				duration,
			};
		}
	}

	protected getOSEnvironmentVariables(): Record<string, string> {
		return {
			GOOS: "darwin",
		};
	}

	private async checkXcodeTools(): Promise<void> {
		try {
			await this.executeCommand("xcode-select -p");
			logger.debug("Xcode command line tools found");
		} catch {
			throw new Error(
				"Xcode command line tools not found. Run: xcode-select --install"
			);
		}
	}
}
