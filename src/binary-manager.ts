import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { errorMessage, logger } from './logger.js';
import { Platform } from './platform.js';
import { PACKAGE_NAME, platformPackageName } from './package-identity.js';
import { AgentBinaryDescriptor, AgentBinaryKind } from './types.js';

export class BinaryManager {
	private readonly buildDir: string;

	constructor() {
		this.buildDir = path.join(import.meta.dirname, '..', 'build');
	}

	/**
	 * Resolve one agent binary for the current platform. Defaults to `core`, so a zero-arg
	 * call in an existing consumer is unchanged.
	 */
	async ensureBinary(kind: AgentBinaryKind = 'core'): Promise<string> {
		// A caller written against the old one-arg signature passes a version string here,
		// which would otherwise surface as an opaque "No 7.75.5 binary is defined".
		if (kind !== 'core' && kind !== 'trace') {
			throw new Error(
				`ensureBinary() received "${String(kind)}" as its first argument. That ` +
					`parameter is the binary kind ("core" | "trace"), and it is the only one: ` +
					`what resolves is whatever the installed platform package, or a local build ` +
					`of the pin in .datadog-agent-version, actually contains.`
			);
		}

		const platform = Platform.current();
		const descriptor = platform.getBinary(kind);
		const packageName = platformPackageName(platform.getName());
		logger.info(
			`Resolving Datadog ${kind} agent binary (${descriptor.outputName}) for platform ` +
				`${platform.getName()} ` +
				`(process.platform=${process.platform}, process.arch=${process.arch})`
		);

		// The optional platform package (e.g. <package name>-linux-x86_64) is the path
		// taken when this package is installed from npm.
		const packagedBinary = await this.resolveFromPlatformPackage(packageName, descriptor);
		if (packagedBinary) {
			logger.info(`Using packaged Datadog ${kind} agent binary: ${packagedBinary}`);
			return packagedBinary;
		}

		logger.warn(
			`No packaged ${kind} binary resolved for ${platform.getName()}; falling back to ` +
				`the build-from-source lookup under ${this.buildDir}. In a Harper runtime this ` +
				`almost always means the optional platform package ${packageName} was not installed.`
		);

		const localBinary = this.localBuildPath(platform, descriptor);
		if (await this.binaryExists(localBinary)) {
			logger.info(`Using locally built Datadog ${kind} agent binary: ${localBinary}`);
			return localBinary;
		}

		throw new Error(
			`Datadog ${kind} agent binary (${descriptor.outputName}) not found for ` +
				`${platform.getName()}. Checked the optional platform package ${packageName} (via its ` +
				`${descriptor.accessorName}() accessor) and the local build path ${localBinary}. ` +
				`Neither resolved a runnable binary.`
		);
	}

	/**
	 * The trace-agent: the process that binds 127.0.0.1:8126 and receives spans. Named so
	 * it is findable by anyone grepping for APM rather than hidden behind a string argument.
	 */
	async ensureTraceAgentBinary(): Promise<string> {
		return this.ensureBinary('trace');
	}

	private async resolveFromPlatformPackage(
		packageName: string,
		descriptor: AgentBinaryDescriptor
	): Promise<string | null> {
		logger.debug(
			`Attempting to resolve the ${descriptor.kind} binary from platform package ` +
				`${packageName} via ${descriptor.accessorName}()`
		);
		try {
			type PackageExports = Record<string, unknown> & {
				default?: Record<string, unknown>;
			};
			const pkg = (await import(packageName)) as PackageExports;
			const accessor = (pkg[descriptor.accessorName] ?? pkg.default?.[descriptor.accessorName]) as
				(() => string) | undefined;
			if (typeof accessor !== 'function') {
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
			logger.debug(`${packageName} reports ${descriptor.kind} binary path: ${binaryPath}`);
			if (await this.binaryExists(binaryPath)) {
				return binaryPath;
			}
			logger.warn(
				`Platform package ${packageName} resolved but its ${descriptor.kind} binary ` + `is missing at ${binaryPath}.`
			);
			return null;
		} catch (error) {
			// Usually the optional dependency was skipped for this platform/arch, but it can
			// also hide a real load failure, so surface the reason.
			logger.warn(
				`Could not load platform package ${packageName}: ${errorMessage(error)}. ` +
					`If this platform should be supported, confirm the optional dependency ` +
					`is installed (npm may skip it on os/cpu mismatch or with --no-optional).`
			);
			return null;
		}
	}

	/**
	 * Where a local build puts a binary: `cli.ts` hands the builder
	 * `<output>/<platform>/bin` as its outputDir, and `create-platform-packages.js` reads
	 * `build/<platform>/bin/<name>` back out. Change the builder's layout and this has to
	 * move with it; nothing else resolves a locally built binary.
	 */
	private localBuildPath(platform: Platform, descriptor: AgentBinaryDescriptor): string {
		return path.join(this.buildDir, platform.getName(), 'bin', descriptor.outputName);
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
