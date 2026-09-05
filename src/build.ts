import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { AgentBinary, BINARIES, binaryFilename } from "./binaries.js";
import { buildTree } from "./layout.js";
import { logger } from "../runtime/log.js";
import { Target } from "./targets.js";

export interface BuildOptions {
	readonly target: Target;
	readonly sourceDir: string;
	readonly outputDir: string;
}

/** Long enough for a cold Go build on a shared runner. */
const BUILD_TIMEOUT_MS = 1_200_000;

/** A probe either answers at once or the interpreter it names is unusable. */
const PROBE_TIMEOUT_MS = 30_000;

interface RunOptions {
	/** Return stdout instead of streaming it, for a command whose output is the answer. */
	readonly capture?: boolean;
	readonly timeoutMs?: number;
}

export function environment(target: Target): NodeJS.ProcessEnv {
	const goPath = buildTree(process.cwd(), target).goPath;
	return {
		...process.env,
		GOPATH: goPath,
		PATH: `${join(goPath, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		GOOS: target.goos,
		GOARCH: target.goarch,
		CGO_ENABLED: "1",
		...target.env,
	};
}

// Streams rather than buffering: a cold agent build outlives any reasonable buffer,
// and the output is the only progress signal CI has.
function run(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: RunOptions = {}
): Promise<string> {
	logger.debug(`${command} ${args.join(" ")}`);
	const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
	return new Promise((fulfil, reject) => {
		const startedAt = Date.now();
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: options.capture ? ["ignore", "pipe", "ignore"] : "inherit",
			timeout: timeoutMs,
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk;
		});
		child.on("error", reject);
		// A timeout kills the child rather than raising, so it arrives here as a null code and a kill
		// signal - as does an OOM kill or a cancelled job. Only the elapsed time tells the three apart.
		child.on("close", (code, signal) =>
			code === 0
				? fulfil(output)
				: reject(
						new Error(
							`${command} ${args.join(" ")} ${
								signal
									? `was killed by ${signal} ${Date.now() - startedAt}ms into a ${timeoutMs}ms budget`
									: `exited ${code}`
							}`
						)
					)
		);
	});
}

// The override adds flags; it cannot remove one. Letting it replace the list would let a CI
// variable ship an agent with embedded Python, which only runs on the machine that built it.
export function buildArgs(binary: AgentBinary): string[] {
	const extra = process.env[binary.argsOverride]?.trim();
	return [...binary.mandatoryArgs, ...(extra ? extra.split(/\s+/) : [])];
}

const PYTHON_PROBE =
	"import sys;print('%d.%d' % sys.version_info[:2], sys.executable)";

/** Reports `<major>.<minor> <executable>` for one interpreter name, or rejects if it is absent. */
type Probe = (candidate: string) => Promise<string>;

/** Same contract as `.go-version`: a tag shipping no file has no opinion. */
export async function pythonPin(sourceDir: string): Promise<string> {
	return readFile(join(sourceDir, ".python-version"), "utf8")
		.then((pin) => pin.trim())
		.catch(() => "");
}

const atLeast = (version: string, pin: string): boolean => {
	const parts = (v: string): number[] => v.split(".").map(Number);
	const [major, minor = 0] = parts(version);
	const [pinMajor, pinMinor = 0] = parts(pin);
	return major > pinMajor || (major === pinMajor && minor >= pinMinor);
};

/**
 * pipx builds each venv with the interpreter pipx itself was installed under, which PATH does not
 * change; ubuntu-22.04's pipx runs under 3.10 and so rejected every dda against upstream's 3.12.
 */
export async function pipxInterpreter(
	pin: string,
	probe: Probe
): Promise<string[]> {
	if (!pin) return [];
	for (const candidate of ["python3", "python"]) {
		const reported = await probe(candidate).catch(() => "");
		const [version, executable] = reported.trim().split(/ (.+)/);
		if (executable && atLeast(version, pin)) return ["--python", executable];
	}
	// Nothing on PATH clears the pin, and pipx's own default may still be newer than what is.
	logger.warn(`No Python ${pin} or newer on PATH; pipx will pick dda's own`);
	return [];
}

async function ensureDda(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	try {
		await run("dda", ["--version"], cwd, env);
	} catch {
		logger.info("dda not found, installing");
		const interpreter = await pipxInterpreter(
			await pythonPin(cwd),
			(candidate) =>
				run(candidate, ["-c", PYTHON_PROBE], cwd, env, {
					capture: true,
					timeoutMs: PROBE_TIMEOUT_MS,
				})
		);
		await run("pipx", ["install", "dda", ...interpreter], cwd, env).catch(() =>
			run("pip", ["install", "dda"], cwd, env)
		);
	}
}

// Upstream's tools/bazel exits 2 when CI is set and XDG_CACHE_HOME does not already name a
// directory, and derives GOCACHE from it. Off CI the same wrapper prints a hint and carries on.
async function cacheHome(): Promise<NodeJS.ProcessEnv> {
	if (!process.env.CI) return {};
	const configured = process.env.XDG_CACHE_HOME?.trim();
	const dir = configured ? resolve(configured) : join(homedir(), ".cache");
	await mkdir(dir, { recursive: true });
	logger.debug(`Using XDG_CACHE_HOME ${dir}`);
	return { XDG_CACHE_HOME: dir };
}

// Upstream's .bazelrc names chocolatey's MSYS2 path; the GitHub image installs to the first entry.
// BAZEL_SH leads, since that is the name upstream already gives this setting.
export function windowsShellCandidates(): string[] {
	const drive = (process.env.SystemDrive || "C:").replace(/[\\/]+$/, "");
	const configured = process.env.BAZEL_SH?.trim();
	return [
		...(configured ? [configured] : []),
		`${drive}/msys64/usr/bin/bash.exe`,
		`${drive}/tools/msys64/usr/bin/bash.exe`,
	];
}

export async function resolveWindowsShell(
	candidates: readonly string[]
): Promise<string> {
	for (const candidate of candidates) {
		try {
			await stat(candidate);
			return candidate;
		} catch {
			continue;
		}
	}
	throw new Error(
		`No MSYS2 bash found for bazel. Looked at: ${candidates.join(", ")}. ` +
			"Install MSYS2 or set BAZEL_SH to an existing bash.exe; without one bazel uses the " +
			"C:/tools/msys64 path hardcoded in upstream .bazelrc and dies on the first shell action."
	);
}

/**
 * `try-import %workspace%/user.bazelrc` is .bazelrc's last line and the file is gitignored at the
 * tag, so the override patches nothing of upstream's. Bazel reads a backslash in an rc file as an escape.
 */
export async function writeBazelShellOverride(
	sourceDir: string,
	shell: string
): Promise<void> {
	const posix = shell.replace(/\\/g, "/");
	await writeFile(
		join(sourceDir, "user.bazelrc"),
		"# Written by @harperfast/datadog-agent-binary. .bazelrc points both of these at\n" +
			"# C:/tools/msys64, which the GitHub Windows image does not have.\n" +
			`common:windows --repo_env=BAZEL_SH=${posix}\n` +
			`common:windows --shell_executable=${posix}\n`,
		"utf8"
	);
	logger.debug(`Pointed bazel's Windows shell at ${posix}`);
}

// tools/bazel.bat exits 2 when %TEMP% is on a volume where NTFS creates no 8.3 short name, which is
// every volume but the profile's; GitHub puts the workspace and RUNNER_TEMP on D:.
async function windowsPreconditions(
	sourceDir: string
): Promise<NodeJS.ProcessEnv> {
	await writeBazelShellOverride(
		sourceDir,
		await resolveWindowsShell(windowsShellCandidates())
	);
	const temp = join(homedir(), "AppData", "Local", "Temp");
	await mkdir(temp, { recursive: true });
	return { TEMP: temp, TMP: temp };
}

/** Creates what upstream's build assumes already exists, and reports the variables naming it. */
export async function prepareHost(
	target: Target,
	sourceDir: string
): Promise<NodeJS.ProcessEnv> {
	return {
		...(await cacheHome()),
		...(target.os === "windows" ? await windowsPreconditions(sourceDir) : {}),
	};
}

/** Builds every binary for one target and returns their shipped paths. Throws on the first failure. */
export async function build({
	target,
	sourceDir,
	outputDir,
}: BuildOptions): Promise<string[]> {
	const base = environment(target);
	if (target.precondition) {
		const [command, ...args] = target.precondition.split(" ");
		await run(command, args, sourceDir, base).catch(() => {
			throw new Error(
				`${target.os} requires \`${target.precondition}\` to succeed first`
			);
		});
	}

	// Before dda, since install-tools and every build task run under this environment.
	const env = { ...base, ...(await prepareHost(target, sourceDir)) };
	await mkdir(outputDir, { recursive: true });
	await ensureDda(sourceDir, env);
	await run(
		"dda",
		["--no-interactive", "inv", "install-tools"],
		sourceDir,
		env
	);

	const shipped: string[] = [];
	for (const binary of BINARIES) {
		logger.info(`Building ${binary.shipsAs} for ${target.name}`);
		await run(
			"dda",
			["--no-interactive", "inv", binary.task, ...buildArgs(binary)],
			sourceDir,
			env
		);

		const from = join(sourceDir, `${binary.builtAt}${target.exe}`);
		const to = join(resolve(outputDir), binaryFilename(binary, target));
		await copyFile(from, to);
		shipped.push(to);
	}
	return shipped;
}
