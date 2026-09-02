import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./logger.js";

const REPO = "https://github.com/DataDog/datadog-agent";
const RELEASES =
	"https://api.github.com/repos/DataDog/datadog-agent/releases/latest";

export async function fetchLatestVersion(): Promise<string> {
	const response = await fetch(RELEASES);
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
