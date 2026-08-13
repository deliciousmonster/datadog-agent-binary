import { BuildResult } from "../types.js";
import { logger } from "../logger.js";
import { BaseBuilder } from "./base.js";

export class LinuxBuilder extends BaseBuilder {
	async build(): Promise<BuildResult> {
		const startTime = Date.now();
		const { platform } = this.config;

		logger.info(`Building Datadog Agent for Linux ${platform.getArch()}...`);

		try {
			await this.ensureOutputDirectory();

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
			GOOS: "linux",
		};
	}
}
