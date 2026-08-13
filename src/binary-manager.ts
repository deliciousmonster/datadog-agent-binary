import * as fs from "fs/promises";
import * as path from "path";
import fetch from "node-fetch";
import { logger } from "./logger.js";
import { Platform } from "./platform.js";
import { PACKAGE_NAME, platformPackageName } from "./package-identity.js";
import { AgentBinaryDescriptor, AgentBinaryKind } from "./types.js";

export interface BinaryInfo {
	version: string;
	platform: Platform;
	downloadUrl: string;
	fileName: string;
	checksum?: string;
}

export class BinaryManager {
	private readonly buildDir: string;
	private readonly binDir: string;

	constructor() {
		this.buildDir = path.join(__dirname, "..", "build");
		this.binDir = path.join(__dirname, "..", "bin");
	}

	/**
	 * Resolve one agent binary for the current platform.
	 *
	 * `kind` leads the parameter list because it is the axis every caller now varies;
	 * it defaults to `core` so the zero-arg call in existing consumers is unchanged.
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

		// Prefer a prebuilt binary shipped via the optional platform package
		// (e.g. <package name>-linux-x86_64). This is the
		// path used when the package is installed from npm.
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

		// Fall back to a locally built binary (build-from-source workflow).
		logger.warn(
			`No packaged ${kind} binary resolved for ${platform.getName()}; falling back to ` +
				`the build-from-source lookup under ${this.buildDir}. In a Harper runtime this ` +
				`almost always means the optional platform package ` +
				`${platformPackageName(platform.getName())} was not installed.`
		);

		// Resolve the version from the pin, not from upstream "latest". Using "latest"
		// here made the fallback look under build/<latest>-<platform>/ — a directory the
		// pinned build never creates — and issued a network call on every cache miss.
		// Observed: the pin was 7.79.1 while the error cited build/7.82.1-macos-arm64.
		const targetVersion = version ?? (await this.resolvePinnedVersion());
		const binaryPath = this.getLocalBuildPath(
			platform,
			descriptor,
			targetVersion
		);

		if (await this.binaryExists(binaryPath)) {
			logger.info(
				`Using locally built Datadog ${kind} agent binary: ${binaryPath}`
			);
			return binaryPath;
		}

		throw new Error(
			`Datadog ${kind} agent binary (${descriptor.outputName}) not found for ` +
				`${platform.getName()}. Checked the optional platform package ` +
				`${platformPackageName(platform.getName())} (via its ` +
				`${descriptor.accessorName}() accessor) and the local build path ` +
				`${binaryPath}; neither resolved a runnable binary.`
		);
	}

	/**
	 * The trace-agent: the process that binds 127.0.0.1:8126 and receives spans.
	 * A named accessor so it is findable by anyone grepping for APM, rather than
	 * hidden behind a string argument.
	 */
	async ensureTraceAgentBinary(version?: string): Promise<string> {
		return this.ensureBinary("trace", version);
	}

	private getDescriptor(
		platform: Platform,
		kind: AgentBinaryKind
	): AgentBinaryDescriptor {
		// ensureBinary() gained a leading `kind` parameter. A caller written against
		// the old one-arg signature passes a version string here, which would
		// otherwise surface as an opaque "No 7.75.5 binary is defined".
		if (kind !== "core" && kind !== "trace") {
			throw new Error(
				`ensureBinary() received "${String(kind)}" as its first argument. That ` +
					`parameter is now the binary kind ("core" | "trace") and the version moved ` +
					`to the second argument: call ensureBinary("core", version).`
			);
		}
		return platform.getBinary(kind);
	}

	/**
	 * Attempts to resolve the given agent binary from the optional platform package
	 * for the current platform. Returns the binary path if the package is installed
	 * and the binary exists, otherwise null.
	 */
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
				// The main package and the platform packages are version-locked, but
				// they are published as separate artifacts and are installed
				// independently, so a rollout goes through a window where a new main
				// package sits on top of an old platform package. Missing accessor is
				// exactly that skew, and naming the accessor makes it diagnosable from
				// this one line.
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

	/** Where the build-from-source workflow leaves this binary. */
	private getLocalBuildPath(
		platform: Platform,
		descriptor: AgentBinaryDescriptor,
		version: string
	): string {
		return path.join(
			this.buildDir,
			`${version}-${platform.getName()}`,
			descriptor.outputName
		);
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
	 * The pinned upstream version, for locating a locally built binary.
	 *
	 * Reads `.datadog-agent-version`, the same single source of truth the builder uses,
	 * so the lookup path matches what a pinned build actually produced. Runtime resolution
	 * must never depend on a network call: this runs inside a Harper worker, where a
	 * request to the GitHub API is both a startup-latency risk and a silent failure mode
	 * on an egress-restricted node.
	 */
	private async resolvePinnedVersion(): Promise<string> {
		const { DatadogAgentDownloader } = await import("./downloader.js");
		return new DatadogAgentDownloader().getPinnedVersion();
	}

	/**
	 * Write the launcher for one binary into `bin/`.
	 *
	 * The generated file is the same one-line shim that ships in `bin/` — both hand
	 * off to `dist/agent-launcher.js` — so regenerating over a shipped shim is a
	 * no-op rather than a downgrade that loses its startup diagnostics.
	 */
	async createBinaryWrapper(descriptor?: AgentBinaryDescriptor): Promise<void> {
		const platform = Platform.current();
		const target = descriptor ?? platform.getBinary("core");
		// datadog-agent[.exe] -> bin/datadog-agent, trace-agent[.exe] -> bin/trace-agent.
		// The extension is stripped so the wrapper name matches the shipped shim (and
		// the package.json "bin" entry) on every platform.
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

// Generated by BinaryManager.createBinaryWrapper(), and identical to the shim
// committed at bin/. All launcher behaviour (env diagnostics, preflight checks,
// Harper spawn semantics) lives in dist/agent-launcher.js so the launchers for
// the core agent and the trace-agent cannot drift apart.
require("../dist/agent-launcher.js").launchAgent("${descriptor.kind}");
`;
	}

	private createWindowsWrapper(descriptor: AgentBinaryDescriptor): string {
		// The original cmd wrapper invoked `dist/binary-manager.js` directly,
		// but that file is a module — it has no top-level main and never
		// spawned the agent. Delegate to the same launcher used on Unix so the
		// agent binary is actually launched (with the v5-required `name` option).
		//
		// Three Windows-specific gotchas the implementation works around:
		//   1. Inlining %~dp0 into the JS string literal corrupts the path —
		//      backslashes get interpreted as JS escapes (\U, \b, ...). Pass
		//      the path through argv instead so it stays a literal string.
		//   2. %~dp0 always has a trailing backslash, so "%~dp0" becomes
		//      "...\foo\" — the MS argv parser treats \" as a literal quote
		//      and the next user arg bleeds in. Appending a dot ("%~dp0.")
		//      makes the trailing char `.`, which path.join normalizes away.
		//   3. With `node -e "<code>" "<path>" <args...>`, there is no script
		//      slot in argv — the path lands at argv[1] and user args start at
		//      argv[2], which is the same index launchAgent() slices from when
		//      invoked as `node bin/<wrapper> <args...>`.
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
			// Every binary is required, not best-effort. A partial install that
			// resolves the core agent and quietly skips the trace-agent is precisely
			// the failure this package shipped once already: APM looks configured,
			// nothing listens on 8126, and every span is dropped without an error.
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
