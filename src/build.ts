import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
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
	env: NodeJS.ProcessEnv
): Promise<void> {
	logger.debug(`${command} ${args.join(" ")}`);
	return new Promise((fulfil, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: "inherit",
			timeout: BUILD_TIMEOUT_MS,
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? fulfil()
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

async function ensureDda(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	try {
		await run("dda", ["--version"], cwd, env);
	} catch {
		logger.info("dda not found, installing");
		await run("pipx", ["install", "dda"], cwd, env).catch(() =>
			run("pip", ["install", "dda"], cwd, env)
		);
	}
}

/** Absolute path the binary ships to, suffixed for the target. */
export function shippedPath(
	binary: AgentBinary,
	target: Target,
	outputDir: string
): string {
	const root = isAbsolute(outputDir)
		? outputDir
		: resolve(process.cwd(), outputDir);
	return join(root, `${binary.shipsAs}${target.exe}`);
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

		const from = join(
			sourceDir,
			binary.builtIn,
			`${binary.builtAs}${target.exe}`
		);
		const to = shippedPath(binary, target, outputDir);
		await copyFile(from, to);
		shipped.push(to);
	}
	return shipped;
}
