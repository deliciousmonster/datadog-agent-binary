import type { AgentBinaryDescriptor, AgentBinaryKind, Architecture, OS } from './types.js';

/** `process.arch` and `process.platform` values this package runs on, in this package's labels. */
const ARCHITECTURES: Partial<Record<string, Architecture>> = { x64: 'x86_64', arm64: 'arm64' };
const OPERATING_SYSTEMS: Partial<Record<string, OS>> = { linux: 'linux', darwin: 'macos', win32: 'windows' };

/**
 * The same bijection read the other way: this package's labels to the `process.platform` /
 * `process.arch` values npm compares `os` and `cpu` against. Derived rather than written
 * out, because it was previously hand-inverted in create-platform-packages.js and encoded
 * a third time as value sets in publish-matrix.js. Three copies of one mapping is how a
 * package shipped `os: ["macos"], cpu: ["x86_64"]` -- our vocabulary, which npm can never
 * match, so the optional dependency was skipped in silence and the consumer got no binaries.
 */
const invert = <T extends string>(table: Partial<Record<string, T>>): Record<T, string> =>
	Object.fromEntries(Object.entries(table).map(([node, ours]) => [ours, node])) as Record<T, string>;

export const NODE_PLATFORMS: Record<OS, string> = invert(OPERATING_SYSTEMS);
export const NODE_ARCHES: Record<Architecture, string> = invert(ARCHITECTURES);

/** What publish-matrix checks a published manifest's `os`/`cpu` against. */
export const NODE_FIELDS: ReadonlyArray<readonly [string, string, ReadonlySet<string>]> = [
	['os', 'platform', new Set(Object.values(NODE_PLATFORMS))],
	['cpu', 'arch', new Set(Object.values(NODE_ARCHES))],
];

export class Platform {
	constructor(
		private readonly os: OS,
		private readonly arch: Architecture
	) {}

	static current(): Platform {
		const arch = ARCHITECTURES[process.arch];
		if (!arch) {
			throw new Error(`Unsupported architecture: ${process.arch}`);
		}
		const os = OPERATING_SYSTEMS[process.platform];
		if (!os) {
			throw new Error(`Unsupported platform: ${process.platform}`);
		}
		return new Platform(os, arch);
	}

	getOS(): OS {
		return this.os;
	}

	getArch(): Architecture {
		return this.arch;
	}

	getGoArch(): string {
		return this.arch === 'x86_64' ? 'amd64' : this.arch;
	}

	getName(): string {
		return `${this.os}-${this.arch}`;
	}

	getBinaries(): AgentBinaryDescriptor[] {
		// Executable extension for this platform (`.exe` on Windows). Mirrors upstream `bin_name()`.
		const ext = this.os === 'windows' ? '.exe' : '';
		return [
			{
				kind: 'core',
				buildTask: 'agent.build',
				buildDir: 'agent',
				buildName: `agent${ext}`,
				outputName: `datadog-agent${ext}`,
				// See AgentBinaryDescriptor.buildArgs for why the core agent needs these.
				buildArgs: '--build-exclude=systemd,python',
				buildArgsEnvVar: 'DD_AGENT_BUILD_ARGS',
				accessorName: 'getBinaryPath',
				processName: 'datadog-agent',
			},
			{
				kind: 'trace',
				buildTask: 'trace-agent.build',
				buildDir: 'trace-agent',
				buildName: `trace-agent${ext}`,
				outputName: `trace-agent${ext}`,
				// Deliberately empty; the core agent's excludes do not apply here.
				buildArgs: '',
				buildArgsEnvVar: 'DD_TRACE_AGENT_BUILD_ARGS',
				accessorName: 'getTraceAgentBinaryPath',
				processName: 'datadog-trace-agent',
			},
		];
	}

	getBinary(kind: AgentBinaryKind): AgentBinaryDescriptor {
		const found = this.getBinaries().find((b) => b.kind === kind);
		if (!found) {
			throw new Error(`No ${kind} binary is defined for platform ${this.getName()}`);
		}
		return found;
	}
}

/**
 * Platforms this package builds and publishes.
 *
 * Drives `create-platform-packages.js --all` and, through `update-optional-deps.js`,
 * the `optionalDependencies` in package.json, so it must match the build matrix in
 * `.github/workflows/build-release.yml` exactly. A platform listed here but absent
 * from the matrix is declared, never built, and never published; npm then skips the
 * missing optional package at install time and the consumer gets no binaries and no
 * error.
 *
 * macOS x86_64 is absent because GitHub retired the `macos-13` Intel runner. Restore
 * it by adding a matrix leg (self-hosted Intel, or a verified darwin/amd64
 * cross-compile with CGO enabled, which the `netcgo` build tag requires) in the same
 * change as the entry here.
 */
export const SUPPORTED_PLATFORMS: Platform[] = [
	new Platform('linux', 'x86_64'),
	new Platform('linux', 'arm64'),
	new Platform('macos', 'arm64'),
	new Platform('windows', 'x86_64'),
];

export function getAllSupportedPlatforms(): string[] {
	return SUPPORTED_PLATFORMS.map((p) => p.getName());
}
