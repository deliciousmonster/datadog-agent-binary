import * as fs from "fs/promises";
import * as path from "path";
import * as tar from "tar";
import { execFileSync } from "node:child_process";
export interface DownloadConfig {
	readonly version: string;
	readonly extractTo: string;
}
import { logger } from "./logger.js";
import { Target } from "./targets.js";

const DATADOG_AGENT_REPO = "https://github.com/DataDog/datadog-agent";
const GITHUB_API_BASE = "https://api.github.com/repos/DataDog/datadog-agent";

export class DatadogAgentDownloader {
	async getLatestVersion(): Promise<string> {
		logger.info("Fetching latest Datadog Agent version...");

		const response = await fetch(`${GITHUB_API_BASE}/releases/latest`);
		if (!response.ok) {
			throw new Error(`Failed to fetch latest version: ${response.statusText}`);
		}

		const data = (await response.json()) as { tag_name: string };
		const version = data.tag_name;

		return version;
	}

	async downloadSource(config: DownloadConfig): Promise<string> {
		const { version, extractTo } = config;

		logger.info(`Downloading Datadog Agent source version ${version}...`);

		await fs.mkdir(path.dirname(extractTo), { recursive: true });

		const extractPath = extractTo;

		// Remove existing source directory if it exists
		await fs.rm(extractPath, { recursive: true, force: true });

		// Clone the repository instead of downloading tarball to preserve git history
		logger.info("Cloning Datadog Agent repository...");

		try {
			// Clone with specific tag
			execFileSync(
				"git",
				[
					"clone",
					"--depth",
					"1",
					"--branch",
					version,
					DATADOG_AGENT_REPO,
					extractPath,
				],
				{ stdio: ["inherit", "pipe", "inherit"] }
			);

			// Ensure we have the correct version information
			const gitOutput = execFileSync(
				"git",
				["-C", extractPath, "describe", "--tags", "--always"],
				{ encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
			);
			logger.info(`Repository cloned at version: ${gitOutput.trim()}`);
		} catch (error) {
			// Fallback to tarball download if git clone fails
			logger.warn("Git clone failed, falling back to tarball download...");

			const tarballUrl = `${DATADOG_AGENT_REPO}/archive/refs/tags/${version}.tar.gz`;
			const tarballPath = path.join(
				path.dirname(extractTo),
				`datadog-agent-${version}.tar.gz`
			);

			logger.debug(`Downloading from: ${tarballUrl}`);

			const response = await fetch(tarballUrl);
			if (!response.ok) {
				throw new Error(`Failed to download source: ${response.statusText}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			await fs.writeFile(tarballPath, buffer);

			logger.info("Extracting source code...");

			await fs.mkdir(extractPath, { recursive: true });

			await tar.extract({
				file: tarballPath,
				cwd: extractPath,
				strip: 1,
			});

			await fs.unlink(tarballPath);

			// Initialize git repo and set version manually for ldflags
			try {
				execFileSync("git", ["-C", extractPath, "init"], { stdio: "ignore" });
				execFileSync("git", ["-C", extractPath, "tag", version], {
					stdio: "ignore",
				});
			} catch {
				// Ignore git errors, version will be set via environment
			}
		}

		logger.info(`Source extracted to: ${extractPath}`);
		return extractPath;
	}

	async checkBuildDependencies(target: Target): Promise<void> {
		logger.info(`Checking build dependencies for ${target.name}...`);

		const requirements: Record<string, string[]> = {
			linux: ["go", "make", "gcc", "git"],
			macos: ["go", "make", "gcc", "git", "xcode-select"],
			windows: ["go", "make", "gcc", "git"],
		};

		const platformRequirements = requirements[target.os] || [];
		const missing: string[] = [];

		logger.debug(`checkBuildDependencies PATH: ${process.env.PATH}`);
		for (const tool of platformRequirements) {
			try {
				const { execSync } = await import("child_process");
				execSync(`which ${tool}`, { stdio: "ignore" });
			} catch {
				missing.push(tool);
			}
		}

		if (missing.length > 0) {
			logger.warn(`Missing build dependencies: ${missing.join(", ")}`);
			logger.warn("Please install missing dependencies before building");
		} else {
			logger.info("All build dependencies satisfied");
		}
	}
}
