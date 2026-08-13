import { execSync, spawn } from "child_process";
import * as path from "path";
import {
	AgentBinaryDescriptor,
	AgentBinaryKind,
	BuildConfig,
	BuildResult,
} from "../types.js";
import { logger } from "../logger.js";

export abstract class BaseBuilder {
	protected config: BuildConfig;

	constructor(config: BuildConfig) {
		this.config = config;
	}

	abstract build(): Promise<BuildResult>;

	/** Shared build sequence. `preflight` runs before anything is compiled. */
	protected async runBuild(
		osLabel: string,
		preflight?: () => Promise<void>
	): Promise<BuildResult> {
		const startTime = Date.now();
		const { platform } = this.config;

		logger.info(
			`Building Datadog Agent for ${osLabel} ${platform.getArch()}...`
		);

		try {
			await this.ensureOutputDirectory();
			await preflight?.();

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

	protected async buildCommon(): Promise<void> {
		logger.info("Checking for dda installation...");
		await this.ensureDdaInstalled();

		logger.info("Installing Go tools...");
		await this.executeCommand("dda --no-interactive inv install-tools");

		// One invoke task per binary. Upstream has no bundling flag: `agent.build`
		// produces the core agent and nothing else, so the trace-agent exists only
		// if `trace-agent.build` runs too. Building just the first entry here is the
		// defect that shipped a package whose APM receiver never bound 127.0.0.1:8126.
		for (const binary of this.config.platform.getBinaries()) {
			const buildArgs = this.getBuildArgs(binary);
			logger.info(
				`Building ${binary.kind} agent via ${binary.buildTask}` +
					`${buildArgs ? ` (args: ${buildArgs})` : ""}...`
			);
			// No trailing space: the command is split on " " and spawned without a
			// shell, so an empty argv entry reaches invoke as an unknown positional.
			const suffix = buildArgs ? ` ${buildArgs}` : "";
			await this.executeCommand(
				`dda --no-interactive inv ${binary.buildTask}${suffix}`
			);
		}
	}

	/**
	 * Per-binary rather than global: the core agent's `--build-exclude=systemd,python`
	 * is wrong on the trace-agent (see `AgentBinaryDescriptor.buildArgs`). Args are
	 * spawned without a shell, so an override must be plain space-separated tokens.
	 */
	protected getBuildArgs(binary: AgentBinaryDescriptor): string {
		return process.env[binary.buildArgsEnvVar]?.trim() || binary.buildArgs;
	}

	protected async executeCommand(
		command: string,
		cwd?: string
	): Promise<string> {
		logger.debug(`Executing: ${command}`);

		const workingDir = cwd || this.config.sourceDir;
		const env = {
			...process.env,
			...this.getEnvironmentVariables(),
		};

		// dda builds run for tens of minutes; stream them instead of buffering.
		if (command.includes("dda")) {
			return this.executeCommandWithRollingOutput(command, workingDir, env);
		}

		try {
			return execSync(command, {
				cwd: workingDir,
				encoding: "utf8",
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 1200000,
				env,
			});
		} catch (error: any) {
			logger.error(`Command failed: ${command}`);
			logger.error(`Exit code: ${error.status}`);
			logger.error(`Error: ${error.message}`);

			if (error.stdout) {
				logger.error(`Stdout:\n${error.stdout.toString()}`);
			}
			if (error.stderr) {
				logger.error(`Stderr:\n${error.stderr.toString()}`);
			}

			throw error;
		}
	}

	private async executeCommandWithRollingOutput(
		command: string,
		cwd: string,
		env: NodeJS.ProcessEnv
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const [cmd, ...args] = command.split(" ");
			const child = spawn(cmd, args, {
				cwd,
				env,
				stdio: ["inherit", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			const rollingLines: string[] = [];
			const maxLines = 6;
			let rollingDisplayActive = false;

			const updateRollingDisplay = () => {
				if (rollingDisplayActive) {
					for (let i = 0; i < Math.min(rollingLines.length, maxLines); i++) {
						process.stdout.write("\x1b[1A\x1b[2K");
					}
				} else {
					rollingDisplayActive = true;
				}

				for (const line of rollingLines.slice(-maxLines)) {
					process.stdout.write(line + "\n");
				}
			};

			const addLine = (line: string, isStderr: boolean) => {
				rollingLines.push((isStderr ? "[stderr] " : "") + line.trim());
				updateRollingDisplay();
			};

			const collect = (isStderr: boolean) => (data: Buffer) => {
				const output = data.toString();
				if (isStderr) {
					stderr += output;
				} else {
					stdout += output;
				}

				for (const line of output.split("\n")) {
					if (line.trim()) {
						addLine(line, isStderr);
					}
				}
			};

			child.stdout?.on("data", collect(false));
			child.stderr?.on("data", collect(true));

			child.on("close", (code) => {
				process.stdout.write("\n");

				if (code === 0) {
					resolve(stdout);
				} else {
					logger.error(`Command failed: ${command}`);
					logger.error(`Exit code: ${code}`);
					if (stderr) {
						logger.error(`Stderr:\n${stderr}`);
					}
					reject(new Error(`Command failed with exit code ${code}`));
				}
			});

			child.on("error", (error) => {
				logger.error(`Command failed: ${command}`);
				logger.error(`Error: ${error.message}`);
				reject(error);
			});
		});
	}

	protected getOSEnvironmentVariables(): Record<string, string> {
		return {};
	}

	protected getEnvironmentVariables(): Record<string, string> {
		const { platform } = this.config;
		const goPath = path.join(process.cwd(), "build", platform.getName(), "go");

		return {
			GOPATH: goPath,
			PATH: `${goPath}/bin${path.delimiter}${process.env.PATH}`,
			GOARCH: platform.getGoArch(),
			CGO_ENABLED: "1",
			...this.getOSEnvironmentVariables(),
		};
	}

	protected async ensureOutputDirectory(): Promise<void> {
		const { mkdir } = await import("fs/promises");
		await mkdir(this.config.outputDir, { recursive: true });
	}

	protected async ensureDdaInstalled(): Promise<void> {
		try {
			await this.executeCommand("dda --version");
			logger.debug("dda is already installed");
		} catch {
			logger.info("dda not found, installing...");
			try {
				await this.executeCommand("which pipx");
				logger.debug("pipx found, using pipx to install dda");
				await this.executeCommand("pipx install dda");
			} catch {
				logger.debug("pipx failed, trying pip to install dda");
				await this.executeCommand("pip install dda");
			}
		}
	}

	protected getAbsoluteOutputPath(fileName: string): string {
		// A relative outputDir resolves from the project root, never from the agent
		// source tree the build commands run in.
		return path.resolve(this.config.outputDir, fileName);
	}

	protected async copyBinariesToOutput(): Promise<
		Partial<Record<AgentBinaryKind, string>>
	> {
		const { chmod, copyFile, mkdir, stat } = await import("fs/promises");
		const { platform, outputDir } = this.config;

		logger.debug(`Ensuring platform bin directory exists: ${outputDir}`);
		await mkdir(outputDir, { recursive: true });

		const outputPaths: Partial<Record<AgentBinaryKind, string>> = {};

		for (const binary of platform.getBinaries()) {
			const sourcePath = path.join(
				this.config.sourceDir,
				"bin",
				binary.buildDir,
				binary.buildName
			);
			const destPath = this.getAbsoluteOutputPath(binary.outputName);

			// Check first so an absent binary names the path it should have been at
			// instead of a bare ENOENT. Publishing one binary short surfaces only as
			// dd-trace dropping spans into a closed socket, with nothing logged.
			try {
				await stat(sourcePath);
			} catch {
				throw new Error(
					`Missing ${binary.kind} agent binary: expected ${sourcePath}. ` +
						`It is produced by \`dda --no-interactive inv ${binary.buildTask}\`; ` +
						`check that task ran and succeeded.`
				);
			}

			try {
				await copyFile(sourcePath, destPath);
			} catch (error: any) {
				logger.error(
					`Failed to copy ${binary.kind} agent ${sourcePath} -> ${destPath}: ${error.message}`
				);
				throw error;
			}

			// npm carries mode bits through pack and install: without the exec bit the
			// binary installs unrunnable and fails at spawn with EACCES. The packaging
			// script sets it too; this keeps the builder's own output runnable.
			if (platform.getOS() !== "windows") {
				await chmod(destPath, 0o755);
			}

			outputPaths[binary.kind] = destPath;
			logger.debug(`Copied ${binary.kind} agent to ${destPath}`);
		}

		return outputPaths;
	}
}
