import { execSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentBinaryDescriptor, AgentBinaryKind, BuildConfig, BuildResult, OS } from './types.js';
import { errorMessage, logger } from './logger.js';

/**
 * What varies between the three build hosts: the log label, and the `GOOS` the toolchain
 * cross-compiles for. Data rather than a subclass per OS, because a subclass whose whole
 * body is one string is a place for the two to drift.
 */
const OS_BUILDS: Record<OS, { label: string; goos: string }> = {
	linux: { label: 'Linux', goos: 'linux' },
	macos: { label: 'macOS', goos: 'darwin' },
	windows: { label: 'Windows', goos: 'windows' },
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
	protected cacheDir?: string;
	protected tempDir?: string;

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

	/** CGO_ENABLED is 1 on every target, so a macOS build needs the command line tools' clang. */
	protected async ensureXcodeTools(): Promise<void> {
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

	protected async readGoVersionPin(): Promise<string | undefined> {
		return this.readToolchainPin('.go-version');
	}

	protected async readPythonVersionPin(): Promise<string | undefined> {
		return this.readToolchainPin('.python-version');
	}

	/**
	 * Old tags ship neither file, so ENOENT is a legitimate "no opinion". Nothing else is:
	 * collapsing EACCES or a truncated clone into the same `undefined` lets a broken source
	 * tree read as an unpinned one, and both callers then fall back to whatever happens to
	 * be on PATH, which is the drift these pins exist to stop.
	 */
	private async readToolchainPin(file: string): Promise<string | undefined> {
		try {
			return await readFile(path.join(this.config.sourceDir, file), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw new Error(`Cannot read ${file} in ${this.config.sourceDir}: ${errorMessage(error)}`, { cause: error });
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
	protected async ensureGoVersion(): Promise<void> {
		// Probed before the pin is read, so a host with no Go fails here on every tag
		// rather than five minutes later inside `dda inv install-tools`. Nothing else
		// checks for a toolchain now that the `which` sweep is gone.
		const reported = await this.executeCommand('go version');
		const pinned = (await this.readGoVersionPin())?.trim();
		if (!pinned) {
			// warn, not debug: every tag this package builds ships the file, so reaching
			// here is already odd, and a DEBUG-gated line is absent from every CI log.
			logger.warn('Source ships no .go-version; building with whatever Go is on PATH');
			return;
		}
		const local = /go(\d+\.\d+(?:\.\d+)?)/.exec(reported)?.[1];
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
		await this.ensureXcodeTools();
		await this.ensureGoVersion();
		await this.ensureCacheDirectory();
		await this.ensureEmbeddedPath();
		await this.ensureWindowsPreconditions();

		logger.info('Checking for dda installation...');
		await this.ensureDdaInstalled();

		logger.info('Installing Go tools...');
		await this.streamCommand('dda --no-interactive inv install-tools');

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
			await this.streamCommand(`dda --no-interactive inv ${binary.buildTask}${suffix}`);
		}
	}

	/**
	 * Per-binary rather than global: every flag the core agent takes is wrong on the
	 * trace-agent, whose task has no rtloader or embedded-path parameters at all (see
	 * `AgentBinaryDescriptor.buildArgs`). Args are spawned without a shell, so an
	 * override must be plain space-separated tokens.
	 */
	protected getBuildArgs(binary: AgentBinaryDescriptor): string {
		return process.env[binary.buildArgsEnvVar]?.trim() || binary.buildArgs;
	}

	/**
	 * `probe` marks a command whose failure is an answer rather than a fault. Without it the
	 * dda, uv and pipx version checks report an absent tool at `error`, with an exit code and
	 * an empty `Stderr:`, so a clean install prints three failures for a build that then
	 * succeeds. Every other command keeps the full dump, which is the only record of why one
	 * that was supposed to work did not.
	 */
	protected async executeCommand(command: string, { probe = false } = {}): Promise<string> {
		logger.debug(`Executing: ${command}`);

		try {
			return execSync(command, {
				cwd: this.config.sourceDir,
				encoding: 'utf8',
				stdio: ['inherit', 'pipe', 'pipe'],
				timeout: 1200000,
				env: { ...process.env, ...this.getEnvironmentVariables() },
			});
		} catch (error) {
			// execSync failures carry the child's exit status and captured output on the
			// thrown Error; nothing narrower than a cast can reach them.
			const execError = error as Error & {
				status?: number;
				stdout?: Buffer | string;
				stderr?: Buffer | string;
			};
			if (probe) {
				logger.debug(`Probe failed (exit ${execError.status}): ${command}`);
				throw error;
			}
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

	/**
	 * The invoke build tasks run for tens of minutes, so their output has to reach the log
	 * as it happens. `inherit` rather than pipes read line by line: nothing accumulates in
	 * this process, and whether fd 1 is a terminal is left to the child instead of being
	 * answered here by drawing cursor escapes into a log that has no cursor.
	 *
	 * Returns nothing on purpose. `inherit` captures nothing, and a `Promise<string>` would
	 * hand a caller a convincing empty string. It is also why streaming is picked per call
	 * site rather than by matching the command text, which is how a later `dda inv --list`
	 * would have come to parse ''.
	 *
	 * No timeout. Both workflows that reach here cap the job at 60 minutes, so a
	 * process-level number under that fails a slow-but-healthy build and one over it never
	 * fires. An idle-output watchdog would need the pipes this deliberately gives up.
	 */
	protected async streamCommand(command: string): Promise<void> {
		logger.debug(`Streaming: ${command}`);

		const [cmd, ...args] = command.split(' ');
		const child = spawn(cmd, args, {
			cwd: this.config.sourceDir,
			env: { ...process.env, ...this.getEnvironmentVariables() },
			stdio: 'inherit',
		});

		return new Promise((resolve, reject) => {
			child.on('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`, { cause: error })));
			child.on('close', (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					// `code` is null for a killed child, and the Go linker is the usual OOM
					// target on a runner, so the signal is the whole diagnosis.
					reject(new Error(`Command killed by ${signal}: ${command}`));
				} else {
					reject(new Error(`Command failed with exit code ${code}: ${command}`));
				}
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
			...(this.cacheDir ? { XDG_CACHE_HOME: this.cacheDir } : {}),
			...(this.tempDir ? { TEMP: this.tempDir, TMP: this.tempDir } : {}),
			...this.pdbEnv(),
		};
	}

	/**
	 * 7.82.1's `go_build` splices `-Wl,--pdb=<bin>.pdb` into extldflags for every Windows
	 * target unless DD_GO_PDB=0, and with CGO_ENABLED=1 that flag reaches the host's ld
	 * for real. Nothing here ships a PDB, so the flag can only cost: a link failure if the
	 * ld on PATH predates `--pdb`, and on a Windows host two extra bazel invocations per
	 * binary, since the same branch calls `bazel cquery @winlibs_mingw64//:gcc` to find a
	 * hermetic MinGW. Turning it off is upstream's own documented escape hatch and returns
	 * the link to what earlier tags did.
	 */
	protected pdbEnv(): Record<string, string> {
		return this.config.platform.getOS() === 'windows' ? { DD_GO_PDB: '0' } : {};
	}

	/**
	 * Upstream's bazel wrapper (`tools/bazel`) exits 2 when `CI` is set and XDG_CACHE_HOME
	 * does not already name an absolute directory, and it derives GOCACHE and GOMODCACHE
	 * from it. With `CI` unset that same wrapper only prints a hint and carries on, so a
	 * laptop build never meets the check and a runner dies four minutes in, inside
	 * `agent.build`. An explicit value wins so a cache action can point this at a path it
	 * restores and saves.
	 */
	protected async ensureCacheDirectory(): Promise<void> {
		if (!process.env.CI) {
			return;
		}
		const configured = process.env.XDG_CACHE_HOME?.trim();
		this.cacheDir = configured ? path.resolve(configured) : path.join(os.homedir(), '.cache');
		await mkdir(this.cacheDir, { recursive: true });
		logger.debug(`Using XDG_CACHE_HOME ${this.cacheDir}`);
	}

	/**
	 * Two host assumptions upstream's Windows build makes that a GitHub runner does not
	 * satisfy. Both gate bazel before anything compiles.
	 *
	 * Guarded on the OS being built FOR, not `process.platform`. `Platform.current()` is
	 * the only thing that ever assembles a BuildConfig (src/index.ts), so target and host
	 * are the same machine, and every other host check in this file already reads
	 * `getOS()`. Guarding on the target is also what keeps this reachable from a hermetic
	 * test on any OS.
	 */
	protected async ensureWindowsPreconditions(): Promise<void> {
		if (this.config.platform.getOS() !== 'windows') {
			return;
		}
		await this.writeBazelShellOverride();
		await this.relocateTempForShortNames();
	}

	/**
	 * Where MSYS2 actually lands. Upstream's `.bazelrc` names chocolatey's path; the
	 * GitHub Windows image installs to the first entry instead. `BAZEL_SH` comes first
	 * when it is set, since that is the name upstream already gives this setting.
	 */
	protected windowsShellCandidates(): string[] {
		const drive = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
		const candidates = [`${drive}/msys64/usr/bin/bash.exe`, `${drive}/tools/msys64/usr/bin/bash.exe`];
		const configured = process.env.BAZEL_SH?.trim();
		return configured ? [configured, ...candidates] : candidates;
	}

	/**
	 * `.bazelrc` at 7.82.1 pins both `--repo_env=BAZEL_SH` and `--shell_executable` to
	 * `C:/tools/msys64/usr/bin/bash.exe`, active on every Windows run through
	 * `common --enable_platform_specific_config`. GitHub's image puts MSYS2 at
	 * `C:\msys64`, and the miss only surfaces once the analysis graph needs a shell
	 * action, tens of minutes into a build. `try-import %workspace%/user.bazelrc` is the
	 * last line of `.bazelrc` and the file is gitignored upstream, so the override needs
	 * nothing of theirs patched and the source tree stays clean for `git describe`.
	 *
	 * Repeated `--repo_env` keys resolve last-wins, which is why the flag is worth
	 * repeating rather than exporting `BAZEL_SH` into the environment:
	 * `--experimental_strict_repo_env` (also set upstream) hides the ambient value from
	 * repository rules entirely.
	 */
	protected async writeBazelShellOverride(): Promise<void> {
		// Backslashes are what an inherited BAZEL_SH is likely to carry, and bazel reads
		// them as escapes in an rc file.
		const shell = (await this.resolveWindowsShell()).replace(/\\/g, '/');
		const file = path.join(this.config.sourceDir, 'user.bazelrc');
		await writeFile(
			file,
			'# Written by @deliciousmonster/datadog-agent-binary. .bazelrc points both of these\n' +
				'# at C:/tools/msys64, which the GitHub Windows image does not have.\n' +
				`common:windows --repo_env=BAZEL_SH=${shell}\n` +
				`common:windows --shell_executable=${shell}\n`,
			'utf8'
		);
		logger.debug(`Pointed bazel's Windows shell at ${shell} via ${file}`);
	}

	protected async resolveWindowsShell(): Promise<string> {
		const candidates = this.windowsShellCandidates();
		for (const candidate of candidates) {
			try {
				await stat(candidate);
			} catch {
				continue;
			}
			return candidate;
		}
		throw new Error(
			`No MSYS2 bash found for bazel. Looked at: ${candidates.join(', ')}. ` +
				'Install MSYS2, or set BAZEL_SH to an existing bash.exe. Without one, bazel falls ' +
				'back to the C:/tools/msys64 path hardcoded in upstream .bazelrc and dies on the ' +
				'first shell action.'
		);
	}

	/**
	 * `tools/bazel.bat` at 7.82.1 creates `%TEMP%\123456789.1234` and exits 2 when Windows
	 * gives that file no 8.3 short name, before bazel starts. NTFS enables short-name
	 * creation on the system volume and disables it on every other volume by default, and
	 * GitHub puts the workspace and RUNNER_TEMP on `D:`, so the drive %TEMP% happens to
	 * sit on decides whether a Windows build starts at all.
	 *
	 * The user profile is on the system volume, so pointing TEMP back at its own Temp is
	 * preferred over `fsutil 8dot3name set <drive> 0`, which needs elevation and
	 * permanently changes a volume's naming policy on a machine this package does not own.
	 * It is also just the Windows default for that user, so on a host whose TEMP was never
	 * moved it changes nothing.
	 */
	protected async relocateTempForShortNames(): Promise<void> {
		this.tempDir = path.join(os.homedir(), 'AppData', 'Local', 'Temp');
		await mkdir(this.tempDir, { recursive: true });
		logger.debug(`Using TEMP ${this.tempDir} so bazel's 8.3 short-name check passes`);
	}

	protected async ensureOutputDirectory(): Promise<void> {
		await mkdir(this.config.outputDir, { recursive: true });
	}

	/**
	 * `get_build_flags` in `tasks/libs/common/utils.py` raises "unable to locate embedded
	 * path" unless `get_embedded_path` finds a `dev` directory under the source root, and
	 * that directory exists only as a side effect of the rtloader install the core agent
	 * now skips. Empty is what upstream wants: the check is `os.path.exists` with no look
	 * inside, and `get_rtloader_paths` over an empty tree returns nothing, so no build-tree
	 * RPATH and no `CGO_LDFLAGS -L` are baked into either binary. `trace-agent.build` needs
	 * the directory too and its `build()` signature has no `--embedded-path` to point
	 * elsewhere, which is why this runs once for the whole descriptor loop rather than as a
	 * core-agent build flag.
	 */
	protected async ensureEmbeddedPath(): Promise<void> {
		await mkdir(path.join(this.config.sourceDir, 'dev'), { recursive: true });
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
			logger.warn('Source ships no .python-version; letting pipx choose its own interpreter for dda');
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
					`${candidate} -c "import sys;print('%d.%d' % sys.version_info[:2], sys.executable)"`,
					{ probe: true }
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
			await this.executeCommand('dda --version', { probe: true });
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
				await this.executeCommand(probe, { probe: true });
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
