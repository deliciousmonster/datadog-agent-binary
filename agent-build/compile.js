// @ts-check
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { builtFor, binaryFilename } from "./binaries.js";

/** @typedef {import("./binaries.js").AgentBinary} AgentBinary */
/** @typedef {import("./toolchain.js").Target} Target */
import { buildTree } from "./layout.js";
import { logger } from "./log.js";

/**
 * @typedef {object} BuildOptions
 * @property {Target} target
 * @property {string} sourceDir
 * @property {string} outputDir
 */

/**
 * Long enough for a cold Go build on the slowest runner, which is macOS.
 *
 * Measured rather than guessed, after guessing wrong: at 20 minutes the macos-arm64 leg was killed by
 * SIGTERM 1,200,762 ms into the core agent build, with the tree still compiling. A killed build reports a
 * null exit code and a signal, the same shape as an OOM kill or a cancelled job, so the only thing that
 * told the three apart was the elapsed time this error already prints. 45 minutes sits under the job's own
 * 60-minute limit, so a genuine hang still ends as a build failure rather than a job timeout.
 */
const BUILD_TIMEOUT_MS = 2_700_000;

/** A probe either answers at once or the interpreter it names is unusable. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} RunOptions
 * @property {boolean} [capture] Return stdout instead of streaming it, for a command whose output is the
 *   answer.
 * @property {number} [timeoutMs]
 */

/** @param {Target} target @returns {NodeJS.ProcessEnv} */
export function environment(target) {
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
/**
 * @param {string} command @param {readonly string[]} args @param {string} cwd
 * @param {NodeJS.ProcessEnv} env @param {RunOptions} [options] @returns {Promise<string>}
 */
function run(command, args, cwd, env, options = {}) {
	logger.debug(`${command} ${args.join(" ")}`);
	const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
	return new Promise((fulfil, reject) => {
		const startedAt = Date.now();
		const child = spawn(command, /** @type {string[]} */ (args), {
			cwd,
			env,
			stdio: options.capture ? ["ignore", "pipe", "ignore"] : "inherit",
			timeout: timeoutMs,
		});
		let output = "";
		child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
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
/** @param {AgentBinary} binary @returns {string[]} */
export function buildArgs(binary) {
	const extra = process.env[binary.argsOverride]?.trim();
	return [...binary.mandatoryArgs, ...(extra ? extra.split(/\s+/) : [])];
}

const PYTHON_PROBE =
	"import sys;print('%d.%d' % sys.version_info[:2], sys.executable)";

/**
 * Reports `<major>.<minor> <executable>` for one interpreter name, or rejects if it is absent.
 *
 * @typedef {(candidate: string) => Promise<string>} Probe
 */

/**
 * The Go toolchain the pinned agent release was written against, from its own `.go-version`.
 *
 * Read from the source rather than configured beside it, for the same reason the Node version is read out
 * of package.json: a second copy of a version number drifts, and this one had. The workflow carried
 * `GO_VERSION: "1.23"` against a source tree asking for 1.26.5, and it passed only because `go.mod` says
 * `go 1.26.0` and Go downloads a newer toolchain on its own to satisfy that. So the number in the workflow
 * was decorative, and the toolchain in use was whatever `go.mod` happened to resolve.
 *
 * Where it bites is a toolchain NEWER than the pin, which go.mod does not object to. Measured here on
 * 2026-09-10: Go 1.27.0 built a macOS system-probe that panicked before main with
 * `strcase.UnicodeVersion "15.0.0" != unicode.Version "17.0.0"`, because 1.27 moved the Unicode tables and
 * `charlievieth/strcase v0.0.5` asserts its own match the runtime's. A binary that dies at init is the
 * worst kind to ship: it packages, it passes a symbol check, and it never runs.
 */
/** @param {string} sourceDir @returns {Promise<string>} */
export async function goPin(sourceDir) {
	return readFile(join(sourceDir, ".go-version"), "utf8")
		.then((pin) => pin.trim())
		.catch(() => "");
}

/** `GOTOOLCHAIN` for a pin, or nothing when the tag ships no `.go-version` to honour. */
/** @param {string} pin @returns {NodeJS.ProcessEnv} */
export function goToolchain(pin) {
	if (!/^\d+\.\d+(\.\d+)?$/.test(pin)) return {};
	// `go1.26.5`, not `1.26.5`: GOTOOLCHAIN takes a toolchain name, and an unprefixed version is rejected
	// rather than ignored, which is the better of the two failures but still a build that does not start.
	return { GOTOOLCHAIN: `go${pin}` };
}

/** Same contract as `.go-version`: a tag shipping no file has no opinion. */
/** @param {string} sourceDir @returns {Promise<string>} */
export async function pythonPin(sourceDir) {
	return readFile(join(sourceDir, ".python-version"), "utf8")
		.then((pin) => pin.trim())
		.catch(() => "");
}

/** @param {string} version @param {string} pin @returns {boolean} */
const atLeast = (version, pin) => {
	const parts = (/** @type {string} */ v) => v.split(".").map(Number);
	const [major, minor = 0] = parts(version);
	const [pinMajor, pinMinor = 0] = parts(pin);
	return major > pinMajor || (major === pinMajor && minor >= pinMinor);
};

/**
 * pipx builds each venv with the interpreter pipx itself was installed under, which PATH does not
 * change; ubuntu-22.04's pipx runs under 3.10 and so rejected every dda against upstream's 3.12.
 */
/** @param {string} pin @param {Probe} probe @returns {Promise<string[]>} */
export async function pipxInterpreter(pin, probe) {
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

/** @param {string} cwd @param {NodeJS.ProcessEnv} env @returns {Promise<void>} */
async function ensureDda(cwd, env) {
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
/** @returns {Promise<NodeJS.ProcessEnv>} */
async function cacheHome() {
	if (!process.env.CI) return {};
	const configured = process.env.XDG_CACHE_HOME?.trim();
	const dir = configured ? resolve(configured) : join(homedir(), ".cache");
	await mkdir(dir, { recursive: true });
	logger.debug(`Using XDG_CACHE_HOME ${dir}`);
	return { XDG_CACHE_HOME: dir };
}

// Upstream's .bazelrc names chocolatey's MSYS2 path; the GitHub image installs to the first entry.
// BAZEL_SH leads, since that is the name upstream already gives this setting.
/** @returns {string[]} */
export function windowsShellCandidates() {
	const drive = (process.env.SystemDrive || "C:").replace(/[\\/]+$/, "");
	const configured = process.env.BAZEL_SH?.trim();
	return [
		...(configured ? [configured] : []),
		`${drive}/msys64/usr/bin/bash.exe`,
		`${drive}/tools/msys64/usr/bin/bash.exe`,
	];
}

/** @param {readonly string[]} candidates @returns {Promise<string>} */
export async function resolveWindowsShell(candidates) {
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
/** @param {string} sourceDir @param {string} shell @returns {Promise<void>} */
export async function writeBazelShellOverride(sourceDir, shell) {
	const posix = shell.replace(/\\/g, "/");
	await writeFile(
		join(sourceDir, "user.bazelrc"),
		"# Written by @deliciousmonster/datadog-agent-binary. .bazelrc points both of these at\n" +
			"# C:/tools/msys64, which the GitHub Windows image does not have.\n" +
			`common:windows --repo_env=BAZEL_SH=${posix}\n` +
			`common:windows --shell_executable=${posix}\n`,
		"utf8"
	);
	logger.debug(`Pointed bazel's Windows shell at ${posix}`);
}

// tools/bazel.bat exits 2 when %TEMP% is on a volume where NTFS creates no 8.3 short name, which is
// every volume but the profile's; GitHub puts the workspace and RUNNER_TEMP on D:.
/** @param {string} sourceDir @returns {Promise<NodeJS.ProcessEnv>} */
async function windowsPreconditions(sourceDir) {
	await writeBazelShellOverride(
		sourceDir,
		await resolveWindowsShell(windowsShellCandidates())
	);
	const temp = join(homedir(), "AppData", "Local", "Temp");
	await mkdir(temp, { recursive: true });
	return { TEMP: temp, TMP: temp };
}

/** Creates what upstream's build assumes already exists, and reports the variables naming it. */
/** @param {Target} target @param {string} sourceDir @returns {Promise<NodeJS.ProcessEnv>} */
export async function prepareHost(target, sourceDir) {
	const pin = await goPin(sourceDir);
	const toolchain = goToolchain(pin);
	if (toolchain.GOTOOLCHAIN)
		logger.info(
			`Building with ${toolchain.GOTOOLCHAIN}, which the release pins`
		);
	else if (pin)
		logger.warn(
			`.go-version reads "${pin}", which is not a version; the toolchain is whatever go.mod resolves`
		);
	return {
		...toolchain,
		...(await cacheHome()),
		...(target.os === "windows" ? await windowsPreconditions(sourceDir) : {}),
	};
}

/** Builds every binary for one target and returns their shipped paths. Throws on the first failure. */
/** @param {BuildOptions} options @returns {Promise<string[]>} */
export async function build({ target, sourceDir, outputDir }) {
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

	/** @type {string[]} */
	const shipped = [];
	// Not every binary exists on every system: system-probe is eBPF and Linux-only, security-agent has no
	// macOS build. Asking for one that does not exist fails the whole build rather than shipping less.
	for (const binary of builtFor(target)) {
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
		await stripBinary(to, target, env);
		shipped.push(to);
	}
	return shipped;
}

/**
 * Drop the debug symbols the build leaves behind, which Datadog's own release does not ship.
 *
 * Measured 2026-09-10 on linux-arm64. Unstripped, this package's core agent is 148,670,000 bytes against
 * Datadog's 111,967,416 and its trace-agent 32,110,328 against 23,017,272, which reads as though we build
 * something much larger. Stripped, the same two binaries are 110,485,040 and 23,066,288: the core agent
 * comes out 1.5 MB *smaller* than Datadog's, which is the Python exclusion showing up, and the trace-agent
 * lands within 49 KB, 0.2%. So the 45.8 MB per platform was never a difference in what was built. It was
 * DWARF nobody ships and nobody reads.
 *
 * Safe against the CI assertion, which is the thing that would break: `verify-package.js` greps the packed
 * binary for a package path, and Go keeps those in pclntab, which `strip` does not touch. The trace-agent
 * carries 58 hits stripped against 106 unstripped, and the check asserts presence rather than a count.
 * Datadog's own stripped trace-agent carries the same 58. Both stripped binaries still report `7.82.1`.
 *
 * A missing `strip` is not a build failure. The binary is correct either way and the cost is disk, so a
 * toolchain without binutils ships a larger package rather than no package.
 */
/** @param {string} file @param {Target} target @param {NodeJS.ProcessEnv} env */
async function stripBinary(file, target, env) {
	// Windows PE debug data is not in a form GNU strip should be pointed at, and the MSVC-shaped toolchain
	// a runner has is not guaranteed. Left alone rather than guessed at.
	if (target.os === "windows") return;
	const before = (await stat(file)).size;
	const strip =
		target.os === "macos" ? ["-S", file] : ["--strip-unneeded", file];
	try {
		await run("strip", strip, dirname(file), env);
	} catch (error) {
		logger.warn(
			`Could not strip ${basename(file)}, shipping it with its debug symbols: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		return;
	}
	const after = (await stat(file)).size;
	logger.info(
		`Stripped ${basename(file)}: ${before} -> ${after} bytes, ${Math.round(
			((before - after) / before) * 100
		)}% smaller`
	);
}
