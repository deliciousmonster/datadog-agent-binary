import { execSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { AgentBinaryDescriptor, AgentBinaryKind, BuildConfig, BuildResult, OS } from './types.js';
import { errorMessage, logger } from './logger.js';

/**
 * Everything that varies between the three build hosts: the log label, the `GOOS` the
 * toolchain cross-compiles for, and the tools that must be on PATH. Data rather than a
 * subclass per OS, because a subclass whose whole body is one string is a place for the
 * two to drift; `requires` lives here for the same reason, having previously been a
 * second OS-keyed table inside the downloader.
 */
export const OS_BUILDS: Record<OS, { label: string; goos: string; requires: string[] }> = {
	linux: { label: 'Linux', goos: 'linux', requires: ['go', 'make', 'gcc', 'git'] },
	macos: { label: 'macOS', goos: 'darwin', requires: ['go', 'make', 'gcc', 'git', 'xcode-select'] },
	windows: { label: 'Windows', goos: 'windows', requires: ['go', 'make', 'gcc', 'git'] },
};

export function createBuilder(config: BuildConfig): AgentBuilder {
	const osName = config.platform.getOS();
	// Refuse an unknown OS here rather than fall through to the host's GOOS, which
	// would compile a binary for the wrong platform and report success.
	if (!OS_BUILDS[osName]) {
		throw new Error(`Unsupported OS: ${osName}`);
	}
	return new AgentBuilder(config);
}

export class AgentBuilder {
	protected config: BuildConfig;

	constructor(config: BuildConfig) {
		this.config = config;
	}

	private osBuild(): { label: string; goos: string } {
		return OS_BUILDS[this.config.platform.getOS()];
	}

	async build(): Promise<BuildResult> {
		const startTime = Date.now();
		const { platform } = this.config;

		logger.info(`Building Datadog Agent for ${this.osBuild().label} ${platform.getArch()}...`);

		try {
			await this.ensureOutputDirectory();
			await this.preflight();

			await this.buildCommon();

			logger.info('Copying binaries to output directory...');
			const outputPaths = await this.copyBinariesToOutput();

			const duration = Date.now() - startTime;

			logger.info(`Build completed successfully in ${duration}ms`);
			for (const [kind, binaryPath] of Object.entries(outputPaths)) {
				logger.info(`Output (${kind}): ${binaryPath}`);
			}

			return {
				success: true,
				platform,
				outputPaths,
				duration,
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			const message = errorMessage(error);
			logger.error(`Build failed: ${message}`);

			return {
				success: false,
				platform,
				error: message,
				duration,
			};
		}
	}

	/** Runs before anything is compiled. Only macOS has something to check. */
	protected async preflight(): Promise<void> {
		if (this.config.platform.getOS() !== 'macos') {
			return;
		}
		try {
			await this.executeCommand('xcode-select -p');
			logger.debug('Xcode command line tools found');
		} catch (error) {
			throw new Error('Xcode command line tools not found. Run: xcode-select --install', { cause: error });
		}
	}

	/** Absent on old tags rather than an error, so a missing file means "no opinion". */
	protected async readGoVersionPin(): Promise<string | undefined> {
		try {
			return await readFile(path.join(this.config.sourceDir, '.go-version'), 'utf8');
		} catch {
			return undefined;
		}
	}

	/** Same contract as `.go-version`: absent means the tag has no opinion. */
	protected async readPythonVersionPin(): Promise<string | undefined> {
		try {
			return await readFile(path.join(this.config.sourceDir, '.python-version'), 'utf8');
		} catch {
			return undefined;
		}
	}

	/**
	 * Upstream pins the toolchain it tests against in `.go-version`. Nothing here used to
	 * read it, so three build paths drifted to three different compilers: CI hardcoded
	 * 1.25.8, a local build took whatever was on PATH, and the source asked for 1.25.10.
	 * That is how a package built from 1.25.10-pinned source came to ship a go1.26.4
	 * binary. A minor-version gap is refused because Go's runtime and crypto defaults
	 * move between minors; a patch gap only warns, since upstream floats those.
	 */
	protected async checkGoVersion(): Promise<void> {
		const pinned = (await this.readGoVersionPin())?.trim();
		if (!pinned) {
			logger.debug('Source ships no .go-version; skipping toolchain check');
			return;
		}
		const local = /go(\d+\.\d+(?:\.\d+)?)/.exec(await this.executeCommand('go version'))?.[1];
		if (!local) {
			logger.warn(`Could not parse the local Go version; source pins ${pinned}`);
			return;
		}
		const minor = (v: string) => v.split('.').slice(0, 2).join('.');
		if (minor(local) !== minor(pinned)) {
			throw new Error(
				`Go ${minor(local)} cannot build this source, which pins Go ${pinned} in .go-version. ` +
					`Install Go ${pinned} (or set GOTOOLCHAIN=go${pinned}) and build again.`
			);
		}
		if (local !== pinned) {
			logger.warn(`Building with Go ${local}; the source pins ${pinned}. Patch gap, continuing.`);
		} else {
			logger.debug(`Go ${local} matches the pinned toolchain`);
		}
	}

	protected async buildCommon(): Promise<void> {
		await this.checkGoVersion();

		logger.info('Checking for dda installation...');
		await this.ensureDdaInstalled();

		logger.info('Installing Go tools...');
		await this.executeCommand('dda --no-interactive inv install-tools');

		// One invoke task per binary. Upstream has no bundling flag: `agent.build`
		// produces the core agent and nothing else, so the trace-agent exists only
		// if `trace-agent.build` runs too. Building just the first entry here is the
		// defect that shipped a package whose APM receiver never bound 127.0.0.1:8126.
		for (const binary of this.config.platform.getBinaries()) {
			const buildArgs = this.getBuildArgs(binary);
			logger.info(
				`Building ${binary.kind} agent via ${binary.buildTask}` + `${buildArgs ? ` (args: ${buildArgs})` : ''}...`
			);
			// No trailing space: the command is split on " " and spawned without a
			// shell, so an empty argv entry reaches invoke as an unknown positional.
			const suffix = buildArgs ? ` ${buildArgs}` : '';
			await this.executeCommand(`dda --no-interactive inv ${binary.buildTask}${suffix}`);
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

	protected async executeCommand(command: string, cwd?: string): Promise<string> {
		logger.debug(`Executing: ${command}`);

		const workingDir = cwd || this.config.sourceDir;
		const env = {
			...process.env,
			...this.getEnvironmentVariables(),
		};

		// dda builds run for tens of minutes; stream them instead of buffering.
		if (command.includes('dda')) {
			return this.executeCommandWithRollingOutput(command, workingDir, env);
		}

		try {
			return execSync(command, {
				cwd: workingDir,
				encoding: 'utf8',
				stdio: ['inherit', 'pipe', 'pipe'],
				timeout: 1200000,
				env,
			});
		} catch (error) {
			// execSync failures carry the child's exit status and captured output on the
			// thrown Error; nothing narrower than a cast can reach them.
			const execError = error as Error & {
				status?: number;
				stdout?: Buffer | string;
				stderr?: Buffer | string;
			};
			logger.error(`Command failed: ${command}`);
			logger.error(`Exit code: ${execError.status}`);
			logger.error(`Error: ${execError.message}`);

			if (execError.stdout) {
				logger.error(`Stdout:\n${execError.stdout.toString()}`);
			}
			if (execError.stderr) {
				logger.error(`Stderr:\n${execError.stderr.toString()}`);
			}

			throw error;
		}
	}

	private async executeCommandWithRollingOutput(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
		return new Promise((resolve, reject) => {
			const [cmd, ...args] = command.split(' ');
			const child = spawn(cmd, args, {
				cwd,
				env,
				stdio: ['inherit', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			const rollingLines: string[] = [];
			const maxLines = 6;
			let rollingDisplayActive = false;

			const updateRollingDisplay = () => {
				if (rollingDisplayActive) {
					for (let i = 0; i < Math.min(rollingLines.length, maxLines); i++) {
						process.stdout.write('\x1b[1A\x1b[2K');
					}
				} else {
					rollingDisplayActive = true;
				}

				for (const line of rollingLines.slice(-maxLines)) {
					process.stdout.write(line + '\n');
				}
			};

			const collect = (isStderr: boolean) => (data: Buffer) => {
				const output = data.toString();
				if (isStderr) {
					stderr += output;
				} else {
					stdout += output;
				}

				for (const line of output.split('\n')) {
					if (line.trim()) {
						rollingLines.push((isStderr ? '[stderr] ' : '') + line.trim());
						updateRollingDisplay();
					}
				}
			};

			child.stdout?.on('data', collect(false));
			child.stderr?.on('data', collect(true));

			child.on('close', (code) => {
				process.stdout.write('\n');

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

			child.on('error', (error) => {
				logger.error(`Command failed: ${command}`);
				logger.error(`Error: ${error.message}`);
				reject(error);
			});
		});
	}

	protected getEnvironmentVariables(): Record<string, string> {
		const { platform } = this.config;
		const goPath = path.join(process.cwd(), 'build', platform.getName(), 'go');

		return {
			GOPATH: goPath,
			PATH: `${goPath}/bin${path.delimiter}${process.env.PATH}`,
			GOARCH: platform.getGoArch(),
			GOOS: this.osBuild().goos,
			CGO_ENABLED: '1',
		};
	}

	protected async ensureOutputDirectory(): Promise<void> {
		await mkdir(this.config.outputDir, { recursive: true });
	}

	/**
	 * pipx creates each venv with the interpreter pipx itself was installed under, and
	 * PATH does not change that. The ubuntu-22.04 runner installs pipx under the image's
	 * Python 3.10 while dda requires 3.12, so `pipx install dda` rejects every published
	 * version and actions/setup-python has no effect on it. Hand pipx an interpreter
	 * explicitly, but only once it is known to satisfy the pin upstream ships in
	 * `.python-version`; otherwise pipx's own default is the better guess.
	 */
	protected async pipxPythonFlag(): Promise<string> {
		const pinned = (await this.readPythonVersionPin())?.trim();
		if (!pinned) {
			return '';
		}
		const atLeast = (version: string) => {
			const [major, minor = 0] = version.split('.').map(Number);
			const [pinnedMajor, pinnedMinor = 0] = pinned.split('.').map(Number);
			return major > pinnedMajor || (major === pinnedMajor && minor >= pinnedMinor);
		};
		for (const candidate of ['python3', 'python']) {
			let reported: string;
			try {
				reported = await this.executeCommand(
					`${candidate} -c "import sys;print('%d.%d' % sys.version_info[:2], sys.executable)"`
				);
			} catch {
				continue;
			}
			const [version, executable] = reported.trim().split(/ (.+)/);
			if (!executable || !atLeast(version)) {
				continue;
			}
			// dda install commands are spawned without a shell and split on spaces, so a
			// path with one in it would arrive as two arguments.
			if (executable.includes(' ')) {
				logger.warn(`Cannot pass ${executable} to pipx: the path contains a space`);
				continue;
			}
			return ` --python ${executable}`;
		}
		logger.warn(`No Python ${pinned} or newer on PATH; letting pipx choose its own interpreter for dda`);
		return '';
	}

	/**
	 * dda must land in an isolated environment, never a user-site install. It locates its
	 * own data files at `sysconfig.get_path("data")/…/dda-data`, which resolves to the
	 * interpreter *prefix*; `pip install --user` writes them to the *user* scheme instead,
	 * so the two never meet and every subcommand dies with
	 * `FileNotFoundError: .../dda-data/uv.lock`. A bare `pip install dda` behind a pyenv
	 * shim is exactly that case, which is why it is refused rather than attempted: it
	 * appears to succeed and breaks at the next command.
	 *
	 * No version floor is enforced here. dda reads `.dda/version` from its working
	 * directory and aborts itself when it is too old ("Repo requires at least dda version
	 * X"), and every invocation below runs with `cwd` at the agent source, so the floor is
	 * already self-enforcing. It is a minimum, not an exact pin, so the newest dda is fine.
	 */
	protected async ensureDdaInstalled(): Promise<void> {
		try {
			await this.executeCommand('dda --version');
			logger.debug('dda is already installed');
			return;
		} catch {
			logger.info('dda not found, installing...');
		}

		for (const [probe, install] of [
			['uv --version', 'uv tool install dda'],
			['pipx --version', 'pipx install dda'],
		]) {
			try {
				await this.executeCommand(probe);
			} catch {
				continue;
			}
			// uv provisions an interpreter of its own; pipx inherits one it cannot change.
			const command = install.startsWith('pipx') ? `${install}${await this.pipxPythonFlag()}` : install;
			logger.debug(`Installing dda with: ${command}`);
			await this.executeCommand(command);
			return;
		}

		throw new Error(
			'dda is not installed and neither uv nor pipx is available to install it in an ' +
				'isolated environment. Install one, or install dda yourself with ' +
				'`uv tool install dda`. Do not use `pip install --user dda`: it resolves its ' +
				'data directory to the interpreter prefix while pip writes to the user scheme, ' +
				'so every dda command fails with a missing dda-data/uv.lock.'
		);
	}

	protected async copyBinariesToOutput(): Promise<Partial<Record<AgentBinaryKind, string>>> {
		const { platform, outputDir } = this.config;

		logger.debug(`Ensuring platform bin directory exists: ${outputDir}`);
		await mkdir(outputDir, { recursive: true });

		const outputPaths: Partial<Record<AgentBinaryKind, string>> = {};

		for (const binary of platform.getBinaries()) {
			const sourcePath = path.join(this.config.sourceDir, 'bin', binary.buildDir, binary.buildName);
			// A relative outputDir resolves from the project root, never from the agent
			// source tree the build commands run in.
			const destPath = path.resolve(outputDir, binary.outputName);

			// Check first so an absent binary names the path it should have been at
			// instead of a bare ENOENT. Publishing one binary short surfaces only as
			// dd-trace dropping spans into a closed socket, with nothing logged.
			try {
				await stat(sourcePath);
			} catch (error) {
				throw new Error(
					`Missing ${binary.kind} agent binary: expected ${sourcePath}. ` +
						`It is produced by \`dda --no-interactive inv ${binary.buildTask}\`; ` +
						`check that task ran and succeeded.`,
					{ cause: error }
				);
			}

			try {
				await copyFile(sourcePath, destPath);
			} catch (error) {
				logger.error(`Failed to copy ${binary.kind} agent ${sourcePath} -> ${destPath}: ${errorMessage(error)}`);
				throw error;
			}

			// npm carries mode bits through pack and install: without the exec bit the
			// binary installs unrunnable and fails at spawn with EACCES. The packaging
			// script sets it too; this keeps the builder's own output runnable.
			if (platform.getOS() !== 'windows') {
				await chmod(destPath, 0o755);
			}

			outputPaths[binary.kind] = destPath;
			logger.debug(`Copied ${binary.kind} agent to ${destPath}`);
		}

		return outputPaths;
	}
}
