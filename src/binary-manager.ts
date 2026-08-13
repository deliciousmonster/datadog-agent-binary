import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "./logger.js";
import { Platform } from "./platform.js";
import { PACKAGE_NAME, platformPackageName } from "./package-identity.js";
import { AgentBinaryDescriptor, AgentBinaryKind } from "./types.js";

export class BinaryManager {
	private readonly buildDir: string;
	private readonly binDir: string;

	constructor() {
		this.buildDir = path.join(__dirname, "..", "build");
		this.binDir = path.join(__dirname, "..", "bin");
	}

	/**
	 * Resolve one agent binary for the current platform. `kind` leads the parameter list
	 * because it is the axis callers vary; it defaults to `core` so a zero-arg call in an
	 * existing consumer is unchanged.
	 */
	async ensureBinary(
		kind: AgentBinaryKind = "core",
		version?: string
	): Promise<string> {
		const platform = Platform.current();
		const descriptor = this.getDescriptor(platform, kind);
		logger.info(
			`Resolving Datadog ${kind} agent binary (${descriptor.outputName}) for platform ` +
				`${platform.getName()} ` +
				`(process.platform=${process.platform}, process.arch=${process.arch})`
		);

		// The optional platform package (e.g. <package name>-linux-x86_64) is the path
		// taken when this package is installed from npm.
		const packagedBinary = await this.resolveFromPlatformPackage(
			platform,
			descriptor
		);
		if (packagedBinary) {
			logger.info(
				`Using packaged Datadog ${kind} agent binary: ${packagedBinary}`
			);
			return packagedBinary;
		}

		logger.warn(
			`No packaged ${kind} binary resolved for ${platform.getName()}; falling back to ` +
				`the build-from-source lookup under ${this.buildDir}. In a Harper runtime this ` +
				`almost always means the optional platform package ` +
				`${platformPackageName(platform.getName())} was not installed.`
		);

		// Resolve from the pin, never upstream "latest". "latest" made the fallback look
		// under build/<latest>-<platform>/, a directory the pinned build never creates, and
		// issued a network call on every cache miss. Observed: the pin was 7.79.1 while the
		// error cited build/7.82.1-macos-arm64.
		const targetVersion = version ?? (await this.resolvePinnedVersion());
		const candidates = this.getLocalBuildPaths(
			platform,
			descriptor,
			targetVersion
		);

		for (const candidate of candidates) {
			if (await this.binaryExists(candidate)) {
				logger.info(
					`Using locally built Datadog ${kind} agent binary: ${candidate}`
				);
				return candidate;
			}
		}

		throw new Error(
			`Datadog ${kind} agent binary (${descriptor.outputName}) not found for ` +
				`${platform.getName()}. Checked the optional platform package ` +
				`${platformPackageName(platform.getName())} (via its ` +
				`${descriptor.accessorName}() accessor) and these local build paths: ` +
				`${candidates.join(", ")}. None resolved a runnable binary.`
		);
	}

	/**
	 * The trace-agent: the process that binds 127.0.0.1:8126 and receives spans. Named so
	 * it is findable by anyone grepping for APM rather than hidden behind a string argument.
	 */
	async ensureTraceAgentBinary(version?: string): Promise<string> {
		return this.ensureBinary("trace", version);
	}

	private getDescriptor(
		platform: Platform,
		kind: AgentBinaryKind
	): AgentBinaryDescriptor {
		// A caller written against the old one-arg signature passes a version string here,
		// which would otherwise surface as an opaque "No 7.75.5 binary is defined".
		if (kind !== "core" && kind !== "trace") {
			throw new Error(
				`ensureBinary() received "${String(kind)}" as its first argument. That ` +
					`parameter is now the binary kind ("core" | "trace") and the version moved ` +
					`to the second argument: call ensureBinary("core", version).`
			);
		}
		return platform.getBinary(kind);
	}

	private async resolveFromPlatformPackage(
		platform: Platform,
		descriptor: AgentBinaryDescriptor
	): Promise<string | null> {
		const packageName = platformPackageName(platform.getName());
		logger.debug(
			`Attempting to resolve the ${descriptor.kind} binary from platform package ` +
				`${packageName} via ${descriptor.accessorName}()`
		);
		try {
			type PackageExports = Record<string, unknown> & {
				default?: Record<string, unknown>;
			};
			const pkg = (await import(packageName)) as PackageExports;
			const accessor = (pkg[descriptor.accessorName] ??
				pkg.default?.[descriptor.accessorName]) as (() => string) | undefined;
			if (typeof accessor !== "function") {
				// The main and platform packages are version-locked but published and
				// installed separately, so a rollout goes through a window where a new main
				// package sits on top of an old platform package. A missing accessor is that
				// skew; naming the accessor makes it diagnosable from this one line.
				logger.warn(
					`Platform package ${packageName} loaded but exports no ` +
						`${descriptor.accessorName}() function, so the ${descriptor.kind} binary ` +
						`cannot be resolved from it. That platform package is almost certainly ` +
						`older than ${PACKAGE_NAME} itself and predates the ` +
						`${descriptor.kind} binary. The two are version-locked: install ` +
						`${packageName} at the same version as the main package.`
				);
				return null;
			}
			const binaryPath = accessor();
			logger.debug(
				`${packageName} reports ${descriptor.kind} binary path: ${binaryPath}`
			);
			if (await this.binaryExists(binaryPath)) {
				return binaryPath;
			}
			logger.warn(
				`Platform package ${packageName} resolved but its ${descriptor.kind} binary ` +
					`is missing at ${binaryPath}.`
			);
			return null;
		} catch (error: any) {
			// Usually the optional dependency was skipped for this platform/arch, but it can
			// also hide a real load failure, so surface the reason.
			logger.warn(
				`Could not load platform package ${packageName}: ${error?.message ?? error}. ` +
					`If this platform should be supported, confirm the optional dependency ` +
					`is installed (npm may skip it on os/cpu mismatch or with --no-optional).`
			);
			return null;
		}
	}

	/**
	 * Candidate locations for a locally built binary, most likely first.
	 *
	 * The first entry is the layout the build actually produces: `cli.ts` passes
	 * `<output>/<platform>/bin` as the builder's outputDir, and
	 * `create-platform-packages.js` reads `build/<platform>/bin/<name>`. The resolver used
	 * to look ONLY at `build/<version>-<platform>/<name>`, a layout nothing has ever
	 * written, so the build-from-source fallback could never succeed. The second entry
	 * keeps that old layout resolvable for a tree built by an older version.
	 */
	private getLocalBuildPaths(
		platform: Platform,
		descriptor: AgentBinaryDescriptor,
		version: string
	): string[] {
		return [
			path.join(
				this.buildDir,
				platform.getName(),
				"bin",
				descriptor.outputName
			),
			path.join(
				this.buildDir,
				`${version}-${platform.getName()}`,
				descriptor.outputName
			),
		];
	}

	private async binaryExists(binaryPath: string): Promise<boolean> {
		try {
			const stat = await fs.stat(binaryPath);
			return stat.isFile();
		} catch {
			return false;
		}
	}

	/**
	 * The pinned upstream version, read from `.datadog-agent-version` (the same source the
	 * builder uses) so the lookup path matches what a pinned build produced.
	 *
	 * Never a network call: this runs inside a Harper worker, where a request to the GitHub
	 * API is both a startup-latency risk and a silent failure on an egress-restricted node.
	 */
	private async resolvePinnedVersion(): Promise<string> {
		const { DatadogAgentDownloader } = await import("./downloader.js");
		return new DatadogAgentDownloader().getPinnedVersion();
	}

	/**
	 * Write the launcher for one binary into `bin/`. The generated file is the same one-line
	 * shim that ships in `bin/`, so regenerating over a shipped shim is a no-op rather than a
	 * downgrade that loses its startup diagnostics.
	 */
	async createBinaryWrapper(descriptor?: AgentBinaryDescriptor): Promise<void> {
		const platform = Platform.current();
		const target = descriptor ?? platform.getBinary("core");
		// Strip the extension so the wrapper name matches the shipped shim (and the
		// package.json "bin" entry) on every platform.
		const wrapperPath = path.join(
			this.binDir,
			path.basename(target.outputName, path.extname(target.outputName))
		);

		if (platform.getOS() === "windows") {
			await fs.writeFile(
				wrapperPath + ".cmd",
				this.createWindowsWrapper(target)
			);
		} else {
			await fs.writeFile(wrapperPath, this.createUnixWrapper(target));
			await fs.chmod(wrapperPath, 0o755);
		}

		logger.debug(`Created ${target.kind} binary wrapper: ${wrapperPath}`);
	}

	/** Write a launcher for every binary this platform ships. */
	async createBinaryWrappers(): Promise<void> {
		for (const descriptor of Platform.current().getBinaries()) {
			await this.createBinaryWrapper(descriptor);
		}
	}

	private createUnixWrapper(descriptor: AgentBinaryDescriptor): string {
		return `#!/usr/bin/env node

// Generated by BinaryManager.createBinaryWrapper(). All launcher behaviour (env
// diagnostics, preflight checks, Harper spawn semantics) lives in dist/agent-launcher.js
// so the core-agent and trace-agent launchers cannot drift apart.
require("../dist/agent-launcher.js").launchAgent("${descriptor.kind}");
`;
	}

	private createWindowsWrapper(descriptor: AgentBinaryDescriptor): string {
		// Windows quoting, in the order it bites:
		//   %~dp0 cannot be inlined into the JS string literal; its backslashes become JS
		//   escapes (\U, \b, ...). Pass it through argv, where it stays a literal string.
		//   %~dp0 always ends in a backslash, so "%~dp0" hands \" to the MS argv parser and
		//   the next user arg bleeds in. The appended dot ("%~dp0.") makes the trailing char
		//   `.`, which path.join normalizes away.
		//   `node -e "<code>" "<path>" <args...>` has no script slot in argv, so the path
		//   lands at argv[1] and user args start at argv[2] - the same index launchAgent()
		//   slices from when invoked as `node bin/<wrapper> <args...>`.
		return `@echo off
node -e "const path=require('path');require(path.join(process.argv[1],'..','dist','agent-launcher.js')).launchAgent('${descriptor.kind}');" "%~dp0." %*
`;
	}

	async installForCurrentPlatform(): Promise<void> {
		const platform = Platform.current();
		const binaries = platform.getBinaries();
		logger.info(
			`Installing Datadog Agent binaries for ${platform.getName()}: ` +
				binaries.map((b) => `${b.kind}=${b.outputName}`).join(", ")
		);

		try {
			// Every binary is required, not best-effort. A partial install that resolves the
			// core agent and quietly skips the trace-agent is the failure this package shipped
			// once already: APM looks configured, nothing listens on 8126, every span is
			// dropped without an error.
			for (const descriptor of binaries) {
				await this.ensureBinary(descriptor.kind);
			}
			await this.createBinaryWrappers();
			logger.info("Installation completed successfully");
		} catch (error: any) {
			logger.error(`Installation failed: ${error.message}`);
			throw error;
		}
	}
}
