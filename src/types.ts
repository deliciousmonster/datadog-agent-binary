import { Platform } from "./platform";

export type Architecture = "x86_64" | "arm64";
export type OS = "linux" | "windows" | "macos";

export interface BuildConfig {
	platform: Platform;
	version?: string;
	outputDir: string;
	sourceDir: string;
	buildArgs?: string[];
}

export interface DownloadConfig {
	version: string;
	platform: Platform;
	extractTo: string;
}

/**
 * The Datadog processes this package ships.
 *
 * `core`  — `cmd/agent`. Metrics, checks, log forwarding, DogStatsD.
 * `trace` — `cmd/trace-agent`. The APM receiver: the process that binds
 *           127.0.0.1:8126 and accepts spans from `dd-trace`. Without it a Node
 *           application emits spans into a closed socket and drops them silently.
 *
 * These are two separate upstream build targets producing two separate binaries.
 * Upstream has no flag that folds the trace-agent into the core agent — `tasks/agent.py`
 * `build()` takes no `bundle` parameter, and `tasks/build_tags.py` lists `trace-agent`
 * as its own target with its own tag set.
 */
export type AgentBinaryKind = "core" | "trace";

/**
 * Everything needed to build, locate, package, and publish one agent binary.
 *
 * The pipeline is descriptor-driven end to end — builders, packaging, and runtime
 * resolution all iterate this list instead of assuming a single binary. Shipping only
 * the core agent (and therefore no APM receiver) is the defect this model exists to
 * make structurally impossible.
 */
export interface AgentBinaryDescriptor {
	/** Stable identity. Also the accessor key in the generated platform package. */
	kind: AgentBinaryKind;

	/** Upstream invoke task, e.g. `agent.build`, `trace-agent.build`. */
	buildTask: string;

	/**
	 * Directory under `<sourceDir>/bin` that upstream writes this binary into.
	 * `agent.build` -> `bin/agent`; `trace-agent.build` -> `bin/trace-agent`
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
	 * The trace-agent needs no excludes. `TRACE_AGENT_TAGS` contains neither `python`
	 * nor `systemd`, and `tasks/trace_agent.py::build()` has no `embedded_path`,
	 * `rtloader_root`, or `exclude_rtloader` parameter — it is a plain `go_build`.
	 * Forwarding the core agent's excludes here would be wrong, not just redundant.
	 */
	buildArgs: string;

	/** Env var that overrides `buildArgs`, so CI can iterate on flags without a code change. */
	buildArgsEnvVar: string;

	/** Accessor exported by the generated platform package. */
	accessorName: string;

	/**
	 * Value passed as Harper's `spawn` `name` option. Harper requires it and uses it as
	 * the PID-lock filename (`<rootPath>/pids/<name>.pid`), which is what guarantees one
	 * process per node across worker threads. Two distinct names => two independent
	 * locks => exactly one core agent and one trace-agent.
	 */
	processName: string;
}

export interface BuildResult {
	success: boolean;
	platform: Platform;
	/** Path to the core agent binary. Retained for backwards compatibility. */
	outputPath?: string;
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
