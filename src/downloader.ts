import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "./log.js";

const REPO = "https://github.com/DataDog/datadog-agent";
const RELEASES =
	"https://api.github.com/repos/DataDog/datadog-agent/releases/latest";

/** The pinned release, so a package cannot be labelled one version and built from another. */
export async function pinnedVersion(): Promise<string | undefined> {
	try {
		return (
			(
				await readFile(join(process.cwd(), ".datadog-agent-version"), "utf8")
			).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

// GITHUB_TOKEN when the runner has one: unauthenticated this is 60 requests an hour per IP, shared
// across every runner, and the build fails on "rate limit exceeded" rather than anything real.
export async function fetchLatestVersion(): Promise<string> {
	const token = process.env.GITHUB_TOKEN;
	const response = await fetch(RELEASES, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch latest version: ${response.statusText}`);
	}
	return ((await response.json()) as { tag_name: string }).tag_name;
}

/** Clones the pinned tag into `into`, replacing whatever was there. Returns the path. */
export async function fetchAgentSource(
	version: string,
	into: string
): Promise<string> {
	logger.info(`Cloning Datadog Agent ${version}`);
	await mkdir(dirname(into), { recursive: true });
	await rm(into, { recursive: true, force: true });

	// Shallow, and by tag: the build reads the version back out through git describe for ldflags.
	execFileSync(
		"git",
		["clone", "--depth", "1", "--branch", version, REPO, into],
		{
			stdio: ["inherit", "pipe", "inherit"],
		}
	);
	const described = execFileSync(
		"git",
		["-C", into, "describe", "--tags", "--always"],
		{
			encoding: "utf8",
			stdio: ["inherit", "pipe", "inherit"],
		}
	);
	logger.info(`Cloned at ${described.trim()}`);
	return into;
}
