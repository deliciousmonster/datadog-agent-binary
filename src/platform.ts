import type {
	AgentBinaryDescriptor,
	AgentBinaryKind,
	Architecture,
	OS,
} from "./types.js";

export abstract class Platform {
	protected readonly arch: Architecture;

	constructor(arch: Architecture) {
		this.arch = arch;
	}

	private static processArchToArchitecture(): Architecture {
		switch (process.arch) {
			case "x64":
				return "x86_64";
			case "arm64":
				return "arm64";
			default:
				throw new Error(`Unsupported architecture: ${process.arch}`);
		}
	}

	static current(): Platform {
		const arch = this.processArchToArchitecture();
		switch (process.platform) {
			case "linux":
				return new Linux(arch);
			case "darwin":
				return new MacOS(arch);
			case "win32":
				return new Windows(arch);
			default:
				throw new Error(`Unsupported platform: ${process.platform}`);
		}
	}

	getArch(): Architecture {
		return this.arch;
	}

	getGoArch(): string {
		switch (this.arch) {
			case "x86_64":
				return "amd64";
			default:
				return this.arch;
		}
	}

	getName(): string {
		return `${this.getOS()}-${this.getArch()}`;
	}

	abstract getOS(): OS;

	/** Core agent filename. Predates `getBinaries()`; kept for existing consumers. */
	getBinaryName(): string {
		return this.getBinary("core").outputName;
	}

	/** Filename of the trace-agent (APM receiver) binary. */
	getTraceAgentBinaryName(): string {
		return this.getBinary("trace").outputName;
	}

	/** Executable extension for this platform (`.exe` on Windows). Mirrors upstream `bin_name()`. */
	protected getExecutableExtension(): string {
		return "";
	}

	getBinaries(): AgentBinaryDescriptor[] {
		const ext = this.getExecutableExtension();
		return [
			{
				kind: "core",
				buildTask: "agent.build",
				buildDir: "agent",
				buildName: `agent${ext}`,
				outputName: `datadog-agent${ext}`,
				// See AgentBinaryDescriptor.buildArgs for why the core agent needs these.
				buildArgs: "--build-exclude=systemd,python",
				buildArgsEnvVar: "DD_AGENT_BUILD_ARGS",
				accessorName: "getBinaryPath",
				processName: "datadog-agent",
			},
			{
				kind: "trace",
				buildTask: "trace-agent.build",
				buildDir: "trace-agent",
				buildName: `trace-agent${ext}`,
				outputName: `trace-agent${ext}`,
				// Deliberately empty; the core agent's excludes do not apply here.
				buildArgs: "",
				buildArgsEnvVar: "DD_TRACE_AGENT_BUILD_ARGS",
				accessorName: "getTraceAgentBinaryPath",
				processName: "datadog-trace-agent",
			},
		];
	}

	getBinary(kind: AgentBinaryKind): AgentBinaryDescriptor {
		const found = this.getBinaries().find((b) => b.kind === kind);
		if (!found) {
			throw new Error(
				`No ${kind} binary is defined for platform ${this.getName()}`
			);
		}
		return found;
	}
}

class Linux extends Platform {
	getOS(): OS {
		return "linux";
	}
}

class MacOS extends Platform {
	getOS(): OS {
		return "macos";
	}
}

class Windows extends Platform {
	getOS(): OS {
		return "windows";
	}

	protected getExecutableExtension(): string {
		return ".exe";
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
	new Linux("x86_64"),
	new Linux("arm64"),
	new MacOS("arm64"),
	new Windows("x86_64"),
];

export function getAllSupportedPlatforms(): string[] {
	return SUPPORTED_PLATFORMS.map((p) => p.getName());
}
