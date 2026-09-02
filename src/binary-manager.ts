import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "./logger.js";
import { BINARIES } from "./binaries.js";
import { currentTarget, Target } from "./targets.js";

export class BinaryManager {
	async ensureBinary(): Promise<string> {
		const target = currentTarget();
		logger.info(
			`Resolving Datadog Agent binary for platform ${target.name} ` +
				`(process.platform=${process.platform}, process.arch=${process.arch})`
		);

		// Prefer a prebuilt binary shipped via the optional platform package
		// (e.g. @harperfast/datadog-agent-binary-linux-x86_64). This is the
		// path used when the package is installed from npm.
		const packagedBinary = await this.resolveFromPlatformPackage(target);
		if (packagedBinary) {
			logger.info(`Using packaged Datadog Agent binary: ${packagedBinary}`);
			return packagedBinary;
		}

		throw new Error(
			`Datadog Agent binary not found for ${target.name}. The optional platform package ` +
				`@harperfast/datadog-agent-binary-${target.name} did not resolve a runnable binary.`
		);
	}

	/**
	 * Attempts to resolve the agent binary from the optional platform package
	 * for the current platform. Returns the binary path if the package is
	 * installed and the binary exists, otherwise null.
	 */
	private async resolveFromPlatformPackage(
		target: Target
	): Promise<string | null> {
		const packageName = `@harperfast/datadog-agent-binary-${target.name}`;
		logger.debug(`Attempting to resolve platform package ${packageName}`);
		try {
			const pkg = (await import(packageName)) as {
				default?: { getBinaryPath?: (name?: string) => string };
				getBinaryPath?: (name?: string) => string;
			};
			const getBinaryPath = pkg.getBinaryPath || pkg.default?.getBinaryPath;
			if (typeof getBinaryPath !== "function") {
				logger.warn(
					`Platform package ${packageName} loaded but does not export a ` +
						`getBinaryPath() function — cannot resolve the agent binary from it.`
				);
				return null;
			}
			const binaryPath = getBinaryPath(BINARIES[0].shipsAs);
			logger.debug(`${packageName} reports binary path: ${binaryPath}`);
			if (await this.binaryExists(binaryPath)) {
				return binaryPath;
			}
			logger.warn(
				`Platform package ${packageName} resolved but its binary is missing ` +
					`at ${binaryPath}.`
			);
			return null;
		} catch (error: any) {
			// Most commonly this means the optional dependency was skipped for
			// this platform/arch. But it can also hide a real load failure, so
			// surface the reason instead of swallowing it silently.
			logger.warn(
				`Could not load platform package ${packageName}: ${error?.message ?? error}. ` +
					`If this platform should be supported, confirm the optional dependency ` +
					`is installed (npm may skip it on os/cpu mismatch or with --no-optional).`
			);
			return null;
		}
	}

	private async binaryExists(binaryPath: string): Promise<boolean> {
		try {
			const stat = await fs.stat(binaryPath);
			return stat.isFile();
		} catch {
			return false;
		}
	}
}
