import type { Platform } from './platform.js';

export type Architecture = 'x86_64' | 'arm64';
export type OS = 'linux' | 'windows' | 'macos';

export interface BuildConfig {
	platform: Platform;
	outputDir: string;
	sourceDir: string;
}

export interface DownloadConfig {
	version: string;
	extractTo: string;
}

/**
 * The Datadog processes this package ships.
 *
 * `core` is `cmd/agent`; `trace` is `cmd/trace-agent`, the APM receiver that binds
 * 127.0.0.1:8126 and accepts spans from `dd-trace`. Without the trace-agent a Node
 * application emits spans into a closed socket and drops them silently.
 *
 * Two separate upstream build targets producing two binaries. Nothing upstream folds
 * the trace-agent into the core agent: `tasks/agent.py` `build()` takes no `bundle`
 * parameter, and `tasks/build_tags.py` lists `trace-agent` as its own target.
 */
export type AgentBinaryKind = 'core' | 'trace';

/**
 * Everything needed to build, ship, and resolve one agent binary.
 *
 * Builders, packaging, and runtime resolution iterate this list instead of assuming a
 * single binary, so the package cannot ship without its APM receiver by omission.
 */
export interface AgentBinaryDescriptor {
	kind: AgentBinaryKind;

	/** Upstream invoke task, e.g. `agent.build`, `trace-agent.build`. */
	buildTask: string;

	/**
	 * Directory under `<sourceDir>/bin` that upstream writes this binary into
	 * (`tasks/trace_agent.py`: `BIN_PATH = os.path.join(".", "bin", "trace-agent")`).
	 */
	buildDir: string;

	/** Filename upstream produces, including any platform extension. */
	buildName: string;

	/** Filename we publish inside the platform package. */
	outputName: string;

	/**
	 * Flags appended to the invoke task.
	 *
	 * The core agent needs `--build-exclude=systemd,python`: the `python` tag links
	 * librtloader and an embedded CPython by an rpath into the build tree, yielding a
	 * binary that only runs on the build machine.
	 *
	 * That flag strips a Go build tag and nothing else. `tasks/agent.py` gates the
	 * embedded-rtloader install on a separate `exclude_rtloader` parameter, so the build
	 * kept doing the expensive work whose output the excluded tag then discarded. Under
	 * the default `enable_bazel=True` that install extracts an LLVM toolchain the Linux
	 * code path never invokes (`bazel/tools/BUILD.bazel` stubs `install_name_tool` for
	 * Windows only, and `dd_cc_packaged.bzl` reaches it through an implicit attribute,
	 * which makes it an unconditional analysis edge). It filled a 14 GB runner before a
	 * single Go file compiled. `--exclude-rtloader --no-enable-bazel` skips both.
	 *
	 * The trace-agent takes none of this. `TRACE_AGENT_TAGS` contains neither excluded
	 * tag, and `tasks/trace_agent.py::build()` is a plain `go_build` whose signature has
	 * no rtloader parameter at all, so forwarding any of it would be wrong rather than
	 * redundant.
	 */
	buildArgs: string;

	/** Env var that overrides `buildArgs`, so CI can iterate on flags without a code change. */
	buildArgsEnvVar: string;

	/** Accessor exported by the generated platform package. */
	accessorName: string;

	/**
	 * Harper's `spawn` `name` option, which Harper requires and uses as the PID-lock
	 * filename (`<rootPath>/pids/<name>.pid`). That lock is what holds each agent to one
	 * process per node across worker threads, so the two kinds need distinct names.
	 */
	processName: string;
}

export interface BuildResult {
	success: boolean;
	platform: Platform;
	/** Every binary produced by this build, keyed by kind. */
	outputPaths?: Partial<Record<AgentBinaryKind, string>>;
	error?: string;
	duration: number;
}

export interface Logger {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
	debug: (message: string) => void;
}
