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

	protected async buildCommon(): Promise<void> {
		logger.info("Checking for dda installation...");
		await this.ensureDdaInstalled();

		logger.info("Installing Go tools...");
		await this.executeCommand("dda --no-interactive inv install-tools");

		// One invoke task per binary. `agent.build` produces the core agent and
		// nothing else: upstream has no bundling flag, so the trace-agent only
		// exists if `trace-agent.build` is run too. Building just the first entry
		// here is exactly the defect that shipped a package whose APM receiver
		// never bound 127.0.0.1:8126.
		for (const binary of this.config.platform.getBinaries()) {
			const buildArgs = this.getBuildArgs(binary);
			logger.info(
				`Building ${binary.kind} agent via ${binary.buildTask}` +
					`${buildArgs ? ` (args: ${buildArgs})` : ""}...`
			);
			// Append args only when non-empty. The command is later split on " "
			// and spawned without a shell, so a trailing space becomes an empty
			// argv entry that invoke rejects as an unknown positional argument.
			const suffix = buildArgs ? ` ${buildArgs}` : "";
			await this.executeCommand(
				`dda --no-interactive inv ${binary.buildTask}${suffix}`
			);
		}
	}

	/**
	 * Flags appended to one binary's invoke task.
	 *
	 * Per-binary rather than global: the core agent's `--build-exclude=systemd,python`
	 * would be wrong on the trace-agent, which links neither (see
	 * `AgentBinaryDescriptor.buildArgs`). Each descriptor names its own override
	 * env var so CI can iterate on flags for one binary without disturbing the
	 * other. Args are spawned without a shell, so each token must stand alone
	 * (no quoted or empty values).
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

		// For long-running build commands, use streaming output
		const isBuildCommand = command.includes("dda");

		if (isBuildCommand) {
			return this.executeCommandWithRollingOutput(command, workingDir, env);
		} else {
			// For quick commands, use execSync
			try {
				const result = execSync(command, {
					cwd: workingDir,
					encoding: "utf8",
					stdio: ["inherit", "pipe", "pipe"],
					timeout: 1200000,
					env,
				});
				return result.toString();
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
	}

	private async executeCommandWithRollingOutput(
		command: string,
		cwd: string,
		env: NodeJS.ProcessEnv
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const [cmd, ...args] = command.split(" ");
			// `name` is set here purely for consistency with the runtime
			// spawn in `bin/datadog-agent` and the BinaryManager-generated
			// wrapper. The builder itself is dev/CI-only — it also calls
			// `execSync` elsewhere in this file, which Harper v5 forbids
			// outright, so the builder can never run inside a Harper-managed
			// process regardless of this option. Stock Node.js ignores
			// `name`, so there is no effect outside Harper either.
			const child = spawn(cmd, args, {
				cwd,
				env,
				stdio: ["inherit", "pipe", "pipe"],
				name: `datadog-agent-builder:${cmd}`,
			} as any);

			let stdout = "";
			let stderr = "";
			const rollingLines: string[] = [];
			const maxLines = 6;
			let rollingDisplayActive = false;

			const updateRollingDisplay = () => {
				if (rollingDisplayActive) {
					// Clear only the rolling display lines
					for (let i = 0; i < Math.min(rollingLines.length, maxLines); i++) {
						process.stdout.write("\x1b[1A\x1b[2K"); // Move up and clear line
					}
				} else {
					// First time - just start the rolling display
					rollingDisplayActive = true;
				}

				// Show the last 6 lines
				const linesToShow = rollingLines.slice(-maxLines);
				linesToShow.forEach((line: string) => {
					process.stdout.write(line + "\n");
				});
			};

			const addLine = (line: string, isStderr = false) => {
				const prefix = isStderr ? "[stderr] " : "";
				rollingLines.push(prefix + line.trim());
				updateRollingDisplay();
			};

			child.stdout?.on("data", (data) => {
				const output = data.toString();
				stdout += output;

				const lines = output.split("\n");
				lines.forEach((line: string) => {
					if (line.trim()) {
						addLine(line, false);
					}
				});
			});

			child.stderr?.on("data", (data) => {
				const output = data.toString();
				stderr += output;

				const lines = output.split("\n");
				lines.forEach((line: string) => {
					if (line.trim()) {
						addLine(line, true);
					}
				});
			});

			child.on("close", (code) => {
				// Leave the final rolling display as-is, just add a newline
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
		let env: Record<string, string> = {};

		// Use platform-specific GOPATH
		const platformName = platform.getName();
		const goPath = path.join(process.cwd(), "build", platformName, "go");
		env.GOPATH = goPath;
		env.PATH = `${goPath}/bin${path.delimiter}${process.env.PATH}`;

		env.GOARCH = platform.getGoArch();
		env.CGO_ENABLED = "1";

		env = {
			...env,
			...this.getOSEnvironmentVariables(),
		};

		return env;
	}

	protected async ensureOutputDirectory(): Promise<void> {
		const { mkdir } = await import("fs/promises");
		await mkdir(this.config.outputDir, { recursive: true });
	}

	protected async ensureDdaInstalled(): Promise<void> {
		try {
			// Try to run dda --version to check if it's installed
			await this.executeCommand("dda --version");
			logger.debug("dda is already installed");
		} catch (error) {
			logger.info("dda not found, installing...");
			try {
				await this.executeCommand("which pipx");
				logger.debug("pipx found, using pipx to install dda");
				await this.executeCommand("pipx install dda");
			} catch (pipxError) {
				logger.debug("pipx failed, trying pip to install dda");
				await this.executeCommand("pip install dda");
			}
		}
	}

	protected getAbsoluteOutputPath(fileName: string): string {
		// Ensure output path is absolute and not relative to source directory
		if (path.isAbsolute(this.config.outputDir)) {
			return path.join(this.config.outputDir, fileName);
		} else {
			// If outputDir is relative, resolve it from the current working directory (project root)
			const projectRoot = process.cwd();
			return path.join(projectRoot, this.config.outputDir, fileName);
		}
	}

	/**
	 * Copy every binary the platform declares into the output directory.
	 *
	 * Returns what it copied, keyed by kind, so `build()` reports each path rather
	 * than asserting a single one.
	 */
	protected async copyBinariesToOutput(): Promise<
		Partial<Record<AgentBinaryKind, string>>
	> {
		const { chmod, copyFile, mkdir, stat } = await import("fs/promises");

		// Create platform-specific bin directory
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

			// Check before copying so an absent binary reports the path it should
			// have been at, not a bare ENOENT. Publishing a package that is quietly
			// short one binary is the failure this whole change exists to prevent:
			// it surfaces only as dd-trace dropping spans into a closed socket in
			// production, with nothing logged anywhere.
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

			// npm carries the mode bits from disk through pack and install, so a
			// binary copied without the exec bit installs unrunnable and fails at
			// spawn with EACCES. Set it here as well as in the packaging script so
			// the builder's own output directory is directly usable.
			if (platform.getOS() !== "windows") {
				await chmod(destPath, 0o755);
			}

			outputPaths[binary.kind] = destPath;
			logger.debug(`Copied ${binary.kind} agent to ${destPath}`);
		}

		return outputPaths;
	}
}
