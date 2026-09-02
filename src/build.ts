import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { AgentBinary, BINARIES } from "./binaries.js";
import { logger } from "./logger.js";
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

function environment(target: Target): NodeJS.ProcessEnv {
	const goPath = join(process.cwd(), "build", target.name, "go");
	return {
		...process.env,
		GOPATH: goPath,
		PATH: `${join(goPath, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		GOOS: target.goos,
		GOARCH: target.goarch,
		CGO_ENABLED: "1",
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
	return new Promise((fulfil, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: options.capture ? ["ignore", "pipe", "ignore"] : "inherit",
			timeout: options.timeoutMs ?? BUILD_TIMEOUT_MS,
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? fulfil(output)
				: reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
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

/** Builds every binary for one target and returns their shipped paths. Throws on the first failure. */
export async function build({
	target,
	sourceDir,
	outputDir,
}: BuildOptions): Promise<string[]> {
	const env = environment(target);
	if (target.precondition) {
		const [command, ...args] = target.precondition.split(" ");
		await run(command, args, sourceDir, env).catch(() => {
			throw new Error(
				`${target.os} requires \`${target.precondition}\` to succeed first`
			);
		});
	}

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
		const to = join(resolve(outputDir), `${binary.shipsAs}${target.exe}`);
		await copyFile(from, to);
		shipped.push(to);
	}
	return shipped;
}
