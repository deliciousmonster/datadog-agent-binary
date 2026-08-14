import { BuildResult } from "../types.js";
import { logger } from "../logger.js";
import { BaseBuilder } from "./base.js";

export class MacOSBuilder extends BaseBuilder {
	async build(): Promise<BuildResult> {
		return this.runBuild("macOS", () => this.checkXcodeTools());
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
		} catch (error) {
			throw new Error(
				"Xcode command line tools not found. Run: xcode-select --install",
				{ cause: error }
			);
		}
	}
}
