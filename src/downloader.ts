import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as tar from "tar";
import { DownloadConfig } from "./types.js";
import { errorMessage, logger } from "./logger.js";
import { Platform } from "./platform.js";

const DATADOG_AGENT_REPO = "https://github.com/DataDog/datadog-agent";
const GITHUB_API_BASE = "https://api.github.com/repos/DataDog/datadog-agent";

/**
 * Single source of truth for the upstream Datadog Agent release this package builds.
 *
 * A plain file at the repo root so CI can read it without Node (`cat
 * .datadog-agent-version`) and the build can read it without duplicating the value in a
 * workflow env block.
 *
 * Deliberately NOT the npm package version: the two move on different cadences, and
 * conflating them produced the defect described on `resolveVersion()` below.
 */
const PINNED_VERSION_FILE = ".datadog-agent-version";

export class DatadogAgentDownloader {
	/**
	 * The upstream release recorded in `.datadog-agent-version`. Resolved relative to this
	 * module rather than `process.cwd()`, so it works when the CLI is invoked from another
	 * directory.
	 */
	async getPinnedVersion(): Promise<string> {
		const pinPath = path.join(__dirname, "..", PINNED_VERSION_FILE);
		let raw: string;
		try {
			raw = await fs.readFile(pinPath, "utf8");
		} catch (error) {
			throw new Error(
				`Could not read the pinned Datadog Agent version from ${pinPath}: ` +
					`${errorMessage(error)}. This file is required: builds must not ` +
					`silently float to whatever upstream released most recently.`,
				{ cause: error }
			);
		}
		const version = raw.trim();
		if (!version) {
			throw new Error(
				`${pinPath} is empty; it must contain a Datadog Agent tag.`
			);
		}
		return version;
	}

	/**
	 * Resolve which upstream version to build, and prove it exists before anything
	 * expensive happens. Two real defects motivate this:
	 *
	 *  1. Floating. With no version supplied the build called `getLatestVersion()` and
	 *     shipped whatever upstream had released that day. The package published as 7.75.5
	 *     actually contains agent 7.79.2, verifiable with
	 *     `strings bin/datadog-agent | grep -E '^7\\.[0-9]+\\.[0-9]+$'`. The default is now
	 *     the pin, never "latest".
	 *
	 *  2. Nonexistent tags. `7.75.5` is not a tag on DataDog/datadog-agent (7.75.x stops at
	 *     7.75.4). The clone fails, the tarball fallback 404s, and the surfaced error is
	 *     "Failed to download source: Not Found", which points at the network rather than
	 *     at the bad pin. The ref is now checked up front.
	 *
	 * The core agent and the trace-agent share an IPC auth handshake and a config schema,
	 * so both must come from the same ref: a resolver that can float can mismatch them.
	 */
	async resolveVersion(requested?: string): Promise<string> {
		if (requested && requested.toLowerCase() === "latest") {
			// Opting into a floating build is allowed, but only explicitly.
			const latest = await this.getLatestVersion();
			logger.warn(
				`Building from upstream "latest" (${latest}) by explicit request. The ` +
					`resulting artifact will NOT match ${PINNED_VERSION_FILE}. Do not publish ` +
					`this build without updating the pin.`
			);
			return latest;
		}

		const version = requested ?? (await this.getPinnedVersion());
		logger.info(
			`Using Datadog Agent version ${version} ` +
				`(${requested ? "explicitly requested" : `pinned in ${PINNED_VERSION_FILE}`})`
		);
		await this.assertRefExists(version);
		return version;
	}

	/**
	 * Fail fast if the tag does not exist upstream, naming the actual problem and showing
	 * the tags that do exist nearby.
	 */
	async assertRefExists(version: string): Promise<void> {
		const refUrl = `${GITHUB_API_BASE}/git/ref/tags/${encodeURIComponent(version)}`;
		let response;
		try {
			response = await fetch(refUrl);
		} catch (error) {
			// A network failure is not a missing tag; do not block the build on it, since the
			// clone will surface a real error moments later.
			logger.warn(
				`Could not verify that Datadog Agent tag ${version} exists ` +
					`(${errorMessage(error)}). Continuing; the clone will fail if it does not.`
			);
			return;
		}

		if (response.ok) {
			logger.debug(`Confirmed upstream tag ${version} exists`);
			return;
		}

		if (response.status !== 404) {
			logger.warn(
				`Tag check for ${version} returned HTTP ${response.status}; continuing.`
			);
			return;
		}

		const nearby = await this.findNearbyTags(version);
		throw new Error(
			`Datadog Agent tag "${version}" does not exist on ${DATADOG_AGENT_REPO}. ` +
				`Update ${PINNED_VERSION_FILE} to a real upstream release.` +
				(nearby.length
					? ` Tags in that series: ${nearby.join(", ")}.`
					: ` No tags found in that series.`)
		);
	}

	/** Best-effort list of released tags sharing the requested version's major.minor. */
	private async findNearbyTags(version: string): Promise<string[]> {
		const series = version.split(".").slice(0, 2).join(".");
		if (!series) return [];
		try {
			const response = await fetch(
				`${GITHUB_API_BASE}/git/matching-refs/tags/${encodeURIComponent(series)}.`
			);
			if (!response.ok) return [];
			const refs = (await response.json()) as { ref: string }[];
			return (
				refs
					.map((r) => r.ref.replace("refs/tags/", ""))
					// Drop rc/beta/feature-branch tags; only stable releases are useful here.
					.filter((tag) => /^\d+\.\d+\.\d+$/.test(tag))
					.slice(-6)
			);
		} catch {
			return [];
		}
	}

	/**
	 * The most recent upstream release. Retained for explicit `--datadog-version latest`
	 * builds; it must never be the implicit default. See `resolveVersion()`.
	 */
	async getLatestVersion(): Promise<string> {
		logger.info("Fetching latest Datadog Agent version...");

		const response = await fetch(`${GITHUB_API_BASE}/releases/latest`);
		if (!response.ok) {
			throw new Error(`Failed to fetch latest version: ${response.statusText}`);
		}

		const data = (await response.json()) as { tag_name: string };
		return data.tag_name;
	}

	async downloadSource(config: DownloadConfig): Promise<string> {
		const { version, extractTo } = config;

		logger.info(`Downloading Datadog Agent source version ${version}...`);

		await fs.mkdir(path.dirname(extractTo), { recursive: true });
		await fs.rm(extractTo, { recursive: true, force: true });

		logger.info("Cloning Datadog Agent repository...");

		const { execSync } = await import("node:child_process");

		// Tracked outside the try/catch: a clone that succeeds but lands on the wrong ref
		// must be fatal, not a reason to retry via tarball. Asserting inside the try would
		// let the catch swallow it and silently produce the same mislabelled artifact.
		let clonedVersion: string | undefined;

		try {
			execSync(
				`git clone --depth 1 --branch ${version} ${DATADOG_AGENT_REPO} "${extractTo}"`,
				{
					stdio: ["inherit", "pipe", "inherit"],
				}
			);

			const gitOutput = execSync(
				`git -C "${extractTo}" describe --tags --always`,
				{ encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
			);
			clonedVersion = gitOutput.trim();
			logger.info(`Repository cloned at version: ${clonedVersion}`);
		} catch {
			logger.warn("Git clone failed, falling back to tarball download...");

			const tarballUrl = `${DATADOG_AGENT_REPO}/archive/refs/tags/${version}.tar.gz`;
			const tarballPath = path.join(
				path.dirname(extractTo),
				`datadog-agent-${version}.tar.gz`
			);

			logger.debug(`Downloading from: ${tarballUrl}`);

			const response = await fetch(tarballUrl);
			if (!response.ok) {
				throw new Error(`Failed to download source: ${response.statusText}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			await fs.writeFile(tarballPath, buffer);

			logger.info("Extracting source code...");

			await fs.mkdir(extractTo, { recursive: true });

			await tar.extract({
				file: tarballPath,
				cwd: extractTo,
				strip: 1,
			});

			await fs.unlink(tarballPath);

			// The build's ldflags read the version from `git describe`; a tarball carries no
			// git metadata, so synthesize it.
			try {
				execSync(`git -C "${extractTo}" init`, { stdio: "ignore" });
				execSync(`git -C "${extractTo}" tag ${version}`, { stdio: "ignore" });
			} catch {
				// Best effort; the version also reaches the build through the environment.
			}
		}

		// A shallow clone of a tag should describe as exactly that tag. If it does not, the
		// working tree is not the version we believe we are building and every artifact from
		// it would be mislabelled. That is how a package published as 7.75.5 came to contain
		// agent 7.79.2.
		if (clonedVersion !== undefined) {
			this.assertCheckoutMatches(version, clonedVersion);
		}

		logger.info(`Source extracted to: ${extractTo}`);
		return extractTo;
	}

	/**
	 * Compare the requested tag against what git actually checked out.
	 *
	 * `git describe --tags --always` on a shallow clone of tag T returns T. It can also
	 * return `T-<n>-g<sha>` (commits past the tag) or a bare sha (no tag reachable); both
	 * mean the tree is not the pinned release.
	 */
	private assertCheckoutMatches(requested: string, described: string): void {
		if (described === requested) return;

		throw new Error(
			`Checked-out source does not match the requested Datadog Agent version. ` +
				`Requested "${requested}", but the clone describes as "${described}". ` +
				`Building from this tree would produce a binary labelled with one version ` +
				`and built from another. Refusing to continue.`
		);
	}

	async checkBuildDependencies(platform: Platform): Promise<void> {
		logger.info(`Checking build dependencies for ${platform.getName()}...`);

		const requirements: Record<string, string[]> = {
			linux: ["go", "make", "gcc", "git"],
			macos: ["go", "make", "gcc", "git", "xcode-select"],
			windows: ["go", "make", "gcc", "git"],
		};

		const platformRequirements = requirements[platform.getOS()] || [];
		const missing: string[] = [];

		logger.debug(`checkBuildDependencies PATH: ${process.env.PATH}`);
		const { execSync } = await import("node:child_process");
		for (const tool of platformRequirements) {
			try {
				execSync(`which ${tool}`, { stdio: "ignore" });
			} catch {
				missing.push(tool);
			}
		}

		if (missing.length > 0) {
			logger.warn(`Missing build dependencies: ${missing.join(", ")}`);
			logger.warn("Please install missing dependencies before building");
		} else {
			logger.info("All build dependencies satisfied");
		}
	}
}
