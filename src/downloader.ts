import fetch from "node-fetch";
import * as fs from "fs/promises";
import * as path from "path";
import * as tar from "tar";
import { DownloadConfig } from "./types.js";
import { logger } from "./logger.js";
import { Platform } from "./platform.js";

const DATADOG_AGENT_REPO = "https://github.com/DataDog/datadog-agent";
const GITHUB_API_BASE = "https://api.github.com/repos/DataDog/datadog-agent";

/**
 * Single source of truth for the upstream Datadog Agent release this package builds.
 *
 * Lives in a plain file at the repo root so CI can read it without Node
 * (`cat .datadog-agent-version`) and the build can read it without duplicating the
 * value in a workflow env block. One pin, one place.
 *
 * This is deliberately NOT the npm package version. The two move on different
 * cadences, and conflating them is what produced the defect described on
 * `resolveVersion()` below.
 */
const PINNED_VERSION_FILE = ".datadog-agent-version";

export class DatadogAgentDownloader {
	/**
	 * The upstream release recorded in `.datadog-agent-version`.
	 *
	 * Resolved relative to this module rather than `process.cwd()`, so it works when
	 * the CLI is invoked from another directory.
	 */
	async getPinnedVersion(): Promise<string> {
		const pinPath = path.join(__dirname, "..", PINNED_VERSION_FILE);
		let raw: string;
		try {
			raw = await fs.readFile(pinPath, "utf8");
		} catch (error: any) {
			throw new Error(
				`Could not read the pinned Datadog Agent version from ${pinPath}: ` +
					`${error?.message ?? error}. This file is required — builds must not ` +
					`silently float to whatever upstream released most recently.`
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
	 * expensive happens.
	 *
	 * Two real defects motivate this:
	 *
	 *  1. Floating. When no version was supplied the build called `getLatestVersion()`
	 *     and shipped whatever upstream had released that day. The package published as
	 *     7.75.5 actually contains agent 7.79.2 — verifiable with
	 *     `strings bin/datadog-agent | grep -E '^7\\.[0-9]+\\.[0-9]+$'`. Nothing compared
	 *     the two. Now the default is the pin, never "latest".
	 *
	 *  2. Nonexistent tags. `7.75.5` is not a tag on DataDog/datadog-agent (7.75.x stops
	 *     at 7.75.4). `git clone --branch 7.75.5` fails, the tarball fallback 404s, and
	 *     the surfaced error is "Failed to download source: Not Found" — which points at
	 *     the network rather than at the bad pin. We now check the ref up front and say
	 *     so plainly.
	 *
	 * This matters more with two binaries than it did with one: the core agent and the
	 * trace-agent share an IPC auth handshake and a config schema, so both must come
	 * from the same ref. A resolver that can float is a resolver that can mismatch them.
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
	 * Fail fast if the tag does not exist upstream, with an error that names the actual
	 * problem and shows the tags that do exist nearby.
	 */
	async assertRefExists(version: string): Promise<void> {
		const refUrl = `${GITHUB_API_BASE}/git/ref/tags/${encodeURIComponent(version)}`;
		let response;
		try {
			response = await fetch(refUrl);
		} catch (error: any) {
			// A network failure is not the same as a missing tag; do not block the build
			// on it, since the clone will surface a real error moments later.
			logger.warn(
				`Could not verify that Datadog Agent tag ${version} exists ` +
					`(${error?.message ?? error}). Continuing; the clone will fail if it does not.`
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
	 * The most recent upstream release.
	 *
	 * Retained for explicit `--datadog-version latest` builds and for the
	 * build-from-source fallback. It must never be the implicit default: see
	 * `resolveVersion()`.
	 */
	async getLatestVersion(): Promise<string> {
		logger.info("Fetching latest Datadog Agent version...");

		const response = await fetch(`${GITHUB_API_BASE}/releases/latest`);
		if (!response.ok) {
			throw new Error(`Failed to fetch latest version: ${response.statusText}`);
		}

		const data = (await response.json()) as { tag_name: string };
		const version = data.tag_name;

		return version;
	}

	async downloadSource(config: DownloadConfig): Promise<string> {
		const { version, extractTo } = config;

		logger.info(`Downloading Datadog Agent source version ${version}...`);

		await fs.mkdir(path.dirname(extractTo), { recursive: true });

		const extractPath = extractTo;

		// Remove existing source directory if it exists
		await fs.rm(extractPath, { recursive: true, force: true });

		// Clone the repository instead of downloading tarball to preserve git history
		logger.info("Cloning Datadog Agent repository...");

		const { execSync } = await import("child_process");

		// Tracked separately from the try/catch below: a clone that succeeds but lands on
		// the wrong ref must be fatal, not a reason to retry via tarball. Asserting inside
		// the try would let the catch swallow it and silently produce the same mislabelled
		// artifact this check exists to prevent.
		let clonedVersion: string | undefined;

		try {
			// Clone with specific tag
			execSync(
				`git clone --depth 1 --branch ${version} ${DATADOG_AGENT_REPO} "${extractPath}"`,
				{
					stdio: ["inherit", "pipe", "inherit"],
				}
			);

			// Ensure we have the correct version information
			const gitOutput = execSync(
				`git -C "${extractPath}" describe --tags --always`,
				{ encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
			);
			clonedVersion = gitOutput.trim();
			logger.info(`Repository cloned at version: ${clonedVersion}`);
		} catch (error) {
			// Fallback to tarball download if git clone fails
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

			await fs.mkdir(extractPath, { recursive: true });

			await tar.extract({
				file: tarballPath,
				cwd: extractPath,
				strip: 1,
			});

			await fs.unlink(tarballPath);

			// Initialize git repo and set version manually for ldflags
			try {
				execSync(`git -C "${extractPath}" init`, { stdio: "ignore" });
				execSync(`git -C "${extractPath}" tag ${version}`, { stdio: "ignore" });
			} catch {
				// Ignore git errors, version will be set via environment
			}
		}

		// A shallow clone of a tag should describe as exactly that tag. If it does not,
		// the working tree is not the version we believe we are building and every
		// artifact produced from it would be mislabelled. That is exactly how a package
		// published as 7.75.5 came to contain agent 7.79.2. Deliberately outside the
		// try/catch above so it cannot be mistaken for a clone failure.
		if (clonedVersion !== undefined) {
			this.assertCheckoutMatches(version, clonedVersion);
		}

		logger.info(`Source extracted to: ${extractPath}`);
		return extractPath;
	}

	/**
	 * Compare the requested tag against what git actually checked out.
	 *
	 * `git describe --tags --always` on a shallow clone of tag T returns T. It can also
	 * return `T-<n>-g<sha>` (commits past the tag) or a bare sha (no tag reachable);
	 * both mean the tree is not the pinned release.
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
		for (const tool of platformRequirements) {
			try {
				const { execSync } = await import("child_process");
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
