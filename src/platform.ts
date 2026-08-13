import {
	AgentBinaryDescriptor,
	AgentBinaryKind,
	Architecture,
	OS,
} from "./types";

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
				return new Unknown(arch);
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

	/**
	 * Filename of the core agent binary.
	 *
	 * Retained so existing consumers keep working. Prefer `getBinaries()`, which
	 * describes every binary this package ships.
	 */
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

	/**
	 * Every agent binary this package builds and ships for this platform.
	 *
	 * Callers iterate this rather than hardcoding a single binary. Adding a future
	 * sub-agent is a new entry here, not a change to five call sites.
	 */
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

	/** Look up one descriptor by kind. Throws if the kind is not defined for this platform. */
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

abstract class Unix extends Platform {
	abstract getOS(): OS;
}

class Linux extends Unix {
	getOS(): OS {
		return "linux";
	}
}

class MacOS extends Unix {
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

class Unknown extends Platform {
	getOS(): OS {
		throw new Error("Unknown OS");
	}

	getBinaries(): AgentBinaryDescriptor[] {
		throw new Error("Unknown platform: no agent binaries are defined");
	}
}

/**
 * Platforms this package builds and publishes.
 *
 * This list drives `create-platform-packages.js --all` and, through
 * `update-optional-deps.js`, the `optionalDependencies` in package.json. It must
 * therefore match the build matrix in `.github/workflows/build-release.yml`
 * exactly. A platform listed here but absent from the matrix is declared as an
 * optional dependency, never built, and never published: npm then silently skips
 * the missing package at install time and the consumer gets no binaries and no
 * error, which is the same silent-failure shape as the original defect.
 *
 * macOS x86_64 is deliberately absent. GitHub retired the `macos-13` Intel
 * runner, so it cannot be built on hosted runners; it was previously declared
 * here and in optionalDependencies while no matrix leg produced it. Restore it by
 * adding a leg (self-hosted Intel, or a verified darwin/amd64 cross-compile with
 * CGO enabled, which the `netcgo` build tag requires) and adding the entry back
 * here in the same change.
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
