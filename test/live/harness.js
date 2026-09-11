// The mechanism a "Live node" row runs through: generate a throwaway fixture app, npm-install a
// real "harper" beside this repo, boot it for real, drive real dd-trace spans into its real
// receiver, and read delivery back over real HTTP. Nothing here is stubbed; every export talks to
// an actual process this module spawned.

import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { PACKAGE_NAME, resolveBinary } from "../../runtime/datadog.js";
import { REPO_ROOT } from "../support/generator.js";
import { findFreePort } from "../support/loopback.js";
import {
	FAKE_API_KEY,
	driveTraffic as driveTrafficWith,
	waitForDeliveredCount,
} from "../support/traffic.js";

const COMPONENT_NAME = basename(REPO_ROOT);

// The same table resources.js's own AGENTS array and scripts/create-platform-packages.js build
// from, so a binary added there is resolved here without this file naming it separately.
const { BINARIES } = await import(
	join(REPO_ROOT, "agent-build", "binaries.js")
);

// The version this tree says it is, which is the one a tag of this tree publishes. The registry row
// boots that artifact, so it applies only once it exists; before the tag it is skipped, not failed.
// DD_LIVE_REGISTRY_VERSION names a published version outright, for the window between bump and tag.
const MANIFEST_VERSION = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf8")
).version;
const REGISTRY_VERSION =
	process.env.DD_LIVE_REGISTRY_VERSION || MANIFEST_VERSION;
const REGISTRY_SPEC = `${PACKAGE_NAME}@${REGISTRY_VERSION}`;
function registryHas(spec) {
	try {
		return (
			execFileSync("npm", ["view", spec, "version"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() !== ""
		);
	} catch {
		return false;
	}
}

const ADMIN_USER = "LIVE_ADMIN";
const ADMIN_PASS = "live-tier-2026";

// No published Harper carries `scope.processes`, so the native row can only run against a local
// build of feat/process-guard and the path to it is the caller's, not this file's.
const NATIVE_WORKTREE = process.env.DD_LIVE_HARPER_NATIVE;

/**
 * One row per Harper line (and, later, per platform) this tier boots against. `moduleLoader` is
 * per-row because it is tied to a live defect, not a fixed choice: harper-process-guard used to
 * statically import `execFileSync` from `node:child_process` and spawn without Harper's required
 * `name` option, both of which only failed under Harper's real `vm-current-context` compartment
 * — its constrained child_process stub omits `execFileSync`, and its constrained spawn throws
 * without a name. Both are fixed upstream now, so this row runs under Harper's actual shipped
 * default rather than the "native" escape hatch that used to be the only way around them.
 */
export const DIMENSIONS = [
	{
		name: "harper@5.2.9 / guard-bundled supervision",
		harperLine: "5.2.9",
		moduleLoader: "vm-current-context",
		expectedSupervision: "guard",
	},
	{
		// The customer's path: not this checkout but the published tarball, installed by npm the way
		// Harper installs a component, with the guard and the platform binaries arriving from the
		// registry as dependencies. Nothing this repo builds is on the node.
		name: `harper@5.2.9 / ${REGISTRY_SPEC} installed from the registry`,
		harperLine: "5.2.9",
		moduleLoader: "vm-current-context",
		expectedSupervision: "guard",
		fromRegistry: true,
		skip: registryHas(REGISTRY_SPEC)
			? false
			: `${REGISTRY_SPEC} is not on the registry yet; tag and publish this version first`,
	},
	{
		// A local worktree, not the registry: this Harper build carries a real `scope.processes`
		// (feat/process-guard), so this row proves the native path rather than mocking it.
		name: "harper (local worktree) / native scope.processes supervision",
		harperLine: NATIVE_WORKTREE && `file:${NATIVE_WORKTREE}`,
		moduleLoader: "vm-current-context",
		expectedSupervision: "harper",
		skip: NATIVE_WORKTREE
			? false
			: "set DD_LIVE_HARPER_NATIVE to an absolute path to a Harper worktree carrying scope.processes",
	},
];

/** Recursively find and hard-kill a process tree. `pgrep -P` throws (exit 1) once a pid has no children. */
function killTree(pid) {
	let children = [];
	try {
		children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" })
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		children = [];
	}
	for (const child of children) killTree(child);
	try {
		process.kill(Number(pid), "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * Real Harper config yaml. Harper validates the parsed doc against its own schema and does not
 * merge in defaultConfig.yaml for a key this file omits (confirmed live: a config carrying only the
 * keys this component touches fails validation on unrelated required siblings), so this is
 * defaultConfig.yaml's own shape with the fixture's free ports and this row's `moduleLoader` in.
 */
function renderRootConfig({ hdbRoot, ports, moduleLoader, allowedBinaries }) {
	return `---
http:
  compressionThreshold: 0
  cors: true
  corsAccessList: ["*"]
  keepAliveTimeout: 30000
  port: ${ports.http}
  securePort: null
  mtls: false
  http2: false
  timeout: 120000
threads:
  count: 1
  debug: false
  preload: null
  preloadRequire: null
authentication:
  authorizeLocal: true
  cacheTTL: 30000
  enableSessions: true
  operationTokenTimeout: 1d
  refreshTokenTimeout: 30d
analytics:
  aggregatePeriod: 60
  replicate: false
applications:
  lockdown: freeze-after-load
  moduleLoader: ${moduleLoader}
  dependencyLoader: native
  allowedSpawnCommands:
    - npm
    - node
${allowedBinaries.map((path) => `    - ${path}`).join("\n")}
  allowedDirectory: any
componentsRoot: components
localStudio:
  enabled: false
logging:
  auditAuthEvents:
    logFailed: false
    logSuccessful: false
  auditLog: true
  auditRetention: 3d
  file: true
  level: info
  root: ${join(hdbRoot, "log")}
  rotation:
    enabled: true
    compress: false
    interval: null
    maxSize: 64M
    path: ${join(hdbRoot, "log")}
  stdStreams: true
mqtt:
  network:
    port: ${ports.mqtt}
    securePort: ${ports.mqttSecure}
    mtls: false
  webSocket: true
  requireAuthentication: true
operationsApi:
  network:
    cors: true
    corsAccessList: ["*"]
    domainSocket: false
    port: ${ports.operations}
    securePort: null
rootPath: ${hdbRoot}
storage:
  writeAsync: false
  caching: true
  compression: true
  rocks:
    compression: null
  noReadAhead: false
  path: database
  backupPath: null
  prefetchWrites: true
tls:
  privateKey: ${join(hdbRoot, "keys", "privateKey.pem")}
  certificateWatchInterval: 300000
node:
  hostname: null
${COMPONENT_NAME}: { package: "${PACKAGE_NAME}" }
`;
}

/** Every binary in the one platform package npm installed for this host, as absolute paths. */
function installedPlatformBinaries(appDir) {
	const [scope, base] = PACKAGE_NAME.split("/");
	const scopeDir = join(appDir, "node_modules", scope);
	const platformPackages = readdirSync(scopeDir).filter((name) =>
		name.startsWith(`${base}-`)
	);
	if (platformPackages.length !== 1) {
		throw new Error(
			`expected one platform package under ${scopeDir}, found ${JSON.stringify(platformPackages)}`
		);
	}
	const binDir = join(scopeDir, platformPackages[0], "bin");
	return readdirSync(binDir).map((file) => join(binDir, file));
}

/** Throws rather than lets a bug boot Harper against the operator's real install. */
function assertSafeHome(home, realHome) {
	// realpath on both sides: the fixture is canonical, and tmpdir() on macOS is not.
	if (home === realHome || !home.startsWith(realpathSync(tmpdir()))) {
		throw new Error(
			`refusing to boot Harper with HOME=${home}: it is not a throwaway temp dir`
		);
	}
}

async function fetchJson(url, authHeader) {
	const response = await fetch(url, { headers: { authorization: authHeader } });
	if (!response.ok) return null;
	return response.json();
}

/**
 * Polls the real status endpoint until the real trace-agent reports `verified: true`, or the
 * deadline passes. Only the trace-agent gates readiness: it is the one this tier drives traffic
 * through. The core agent binds DogStatsD (8125) and its GUI (5002) on fixed ports of its own that
 * this harness does not namespace, so a second live Datadog agent already on the host — another
 * `test:live` run, an operator's own install — can make it lose those binds and exit; that failure
 * is real and is surfaced in the returned status, not hidden, but it does not fail the boot.
 */
async function waitForTraceAgentVerified(
	statusUrl,
	authHeader,
	child,
	deadlineMs
) {
	const deadline = Date.now() + deadlineMs;
	let status;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`harper run exited (code ${child.exitCode}) before the trace-agent verified; see its log`
			);
		}
		status =
			(await fetchJson(statusUrl, authHeader).catch(() => null)) ?? status;
		const trace = status?.processes?.find(
			(process) => process.kind === "trace"
		);
		if (trace?.verified) return status;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`the trace-agent did not verify within ${deadlineMs}ms; last DatadogStatus: ${JSON.stringify(status) ?? "(never answered)"}`
	);
}

/**
 * Generates a throwaway fixture app, npm-installs a real Harper plus this repo into it, resolves
 * the real agent binaries, writes the fixture's own root config, and boots `harper run` as a
 * detached child. Returns once the real trace-agent has verified over real HTTP.
 */
export async function bootHarper(row) {
	const realHome = process.env.HOME;
	// Canonical from the start: on macOS tmpdir() is /var/..., a symlink to /private/var/..., and the
	// component resolves its binaries through the platform package at the real path. Harper's spawn
	// allowlist compares strings, so an allowed /var/... path never matches a spawn of /private/var/....
	const workDir = realpathSync(mkdtempSync(join(tmpdir(), "dd-live-")));
	// Reassigned once spawned, so a failure between spawn and readiness still kills the real child
	// this function started rather than leaking it.
	let child;
	try {
		return await bootHarperInto(workDir, row, realHome, (spawned) => {
			child = spawned;
		});
	} catch (error) {
		if (child) killTree(child.pid);
		// The fixture goes, so what Harper wrote has to travel with the error or it is gone with it.
		const log = join(workDir, "harper-run.log");
		const tail = existsSync(log)
			? readFileSync(log, "utf8").split("\n").slice(-40).join("\n")
			: "(harper-run.log was never written)";
		rmSync(workDir, { recursive: true, force: true });
		error.message += `\n--- last 40 lines of harper-run.log ---\n${tail}`;
		throw error;
	}
}

async function bootHarperInto(workDir, row, realHome, onSpawn) {
	const home = join(workDir, "home");
	const hdbRoot = join(workDir, "hdb");
	const appDir = join(workDir, "app");
	for (const dir of [home, hdbRoot, appDir])
		mkdirSync(dir, { recursive: true });
	assertSafeHome(home, realHome);

	writeFileSync(
		join(appDir, "package.json"),
		JSON.stringify(
			{
				name: "dd-live-fixture",
				private: true,
				version: "0.0.0",
				devDependencies: { harper: row.harperLine },
				dependencies: {
					[PACKAGE_NAME]: row.fromRegistry
						? REGISTRY_VERSION
						: `file:${REPO_ROOT}`,
				},
			},
			null,
			"\t"
		)
	);
	execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
		cwd: appDir,
		stdio: "ignore",
	});

	const harperBin = join(appDir, "node_modules", ".bin", "harper");
	if (!existsSync(harperBin)) {
		throw new Error(`npm install in ${appDir} did not produce ${harperBin}`);
	}

	const ports = {
		http: await findFreePort(),
		operations: await findFreePort(),
		mqtt: await findFreePort(),
		mqttSecure: await findFreePort(),
		receiver: await findFreePort(),
		expvar: await findFreePort(),
		debug: await findFreePort(),
	};
	// What Harper is allowed to spawn: the registry row's binaries live in the platform package npm
	// installed beside the component (only the host's own installs; npm skips the others by os/cpu),
	// the repo row's in this checkout's build output.
	const componentDir = row.fromRegistry
		? join(appDir, "node_modules", ...PACKAGE_NAME.split("/"))
		: REPO_ROOT;
	const allowedBinaries = row.fromRegistry
		? installedPlatformBinaries(appDir)
		: await Promise.all(
				BINARIES.map((binary) =>
					resolveBinary({ shipsAs: binary.shipsAs, title: binary.shipsAs })
				)
			);

	// Confirmed against this repo's own runtime/datadog.js: HOME is what os.homedir() (and so
	// getPropsFilePath) resolves from, so this is what keeps `install` off the operator's real
	// ~/.harperdb/hdb_boot_properties.file.
	console.log(`[live] HOME for this boot: ${home} (real HOME: ${realHome})`);
	const harperEnv = { ...process.env, HOME: home };

	execFileSync(harperBin, ["install"], {
		cwd: appDir,
		env: {
			...harperEnv,
			ROOTPATH: hdbRoot,
			HDB_ADMIN_USERNAME: ADMIN_USER,
			HDB_ADMIN_PASSWORD: ADMIN_PASS,
		},
		stdio: ["ignore", "ignore", "ignore"],
	});

	writeFileSync(
		join(hdbRoot, "harper-config.yaml"),
		renderRootConfig({
			hdbRoot,
			ports,
			moduleLoader: row.moduleLoader,
			allowedBinaries,
		})
	);
	mkdirSync(join(hdbRoot, "components"), { recursive: true });
	symlinkSync(componentDir, join(hdbRoot, "components", COMPONENT_NAME));
	// installApplications() re-installs any `package:`-named entry whose lock record does not match
	// the live config; this pre-populated record is what tells it the symlinked directory above is
	// already the install, so it never tries to npm-install PACKAGE_NAME from the real registry.
	writeFileSync(
		join(hdbRoot, "harper-application-lock.json"),
		JSON.stringify({
			applications: { [COMPONENT_NAME]: { package: PACKAGE_NAME } },
		})
	);

	const logFd = openSync(join(workDir, "harper-run.log"), "a");
	const child = spawn(harperBin, ["run", appDir], {
		cwd: appDir,
		env: {
			...harperEnv,
			ROOTPATH: hdbRoot,
			DD_API_KEY: FAKE_API_KEY,
			DD_SITE: "datadoghq.com",
			DD_APM_RECEIVER_PORT: String(ports.receiver),
			DD_EXPVAR_PORT: String(ports.expvar),
			DD_APM_DEBUG_PORT: String(ports.debug),
		},
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	child.unref();
	onSpawn(child);

	const baseUrl = `http://127.0.0.1:${ports.http}`;
	const statusUrl = `${baseUrl}/DatadogStatus/`;
	const authHeader =
		"Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");

	await waitForTraceAgentVerified(statusUrl, authHeader, child, 90_000);

	return {
		baseUrl,
		statusUrl,
		authHeader,
		receiverPort: ports.receiver,
		adminUser: ADMIN_USER,
		adminPass: ADMIN_PASS,
		child,
		workDir,
		async stop() {
			killTree(child.pid);
			// DD_LIVE_KEEP leaves the fixture (harper-run.log, hdb/log, the agents' own logs) for a look.
			if (process.env.DD_LIVE_KEEP)
				console.log(`[live] fixture kept at ${workDir}`);
			else rmSync(workDir, { recursive: true, force: true });
		},
	};
}

// The traffic-driving mechanism lives in support/traffic.js, shared with
// test/binaries/supervision-equivalence.test.js; only the env var and span naming are this file's own.
const LIVE_SCRIPT = {
	envVar: "LIVE_SPAN_COUNT",
	spanName: "live-harness.span",
	tagKey: "live.iteration",
};

/** Real spans, from a real child process, into the real receiver `handle` points at. Blocks until flushed. */
export async function driveTraffic(handle, count) {
	driveTrafficWith(handle.receiverPort, count, LIVE_SCRIPT);
}

/** A real authenticated GET against the running node's own DatadogStatus resource. Returns the parsed body. */
export async function readDelivery(handle) {
	const body = await fetchJson(handle.statusUrl, handle.authHeader);
	if (!body)
		throw new Error(`DatadogStatus at ${handle.statusUrl} did not answer`);
	return body;
}

/**
 * Polls DatadogStatus until the real receiver reports `count` traces delivered, or the deadline passes.
 * Returns the last status read, which is `undefined` only if DatadogStatus never answered at all; a read
 * that fails mid-poll keeps the previous status rather than discarding what the run already saw.
 */
export async function waitForDelivery(handle, count, deadlineMs) {
	let status;
	await waitForDeliveredCount(
		async () => {
			status = await readDelivery(handle).catch(() => status);
			return status?.delivery;
		},
		count,
		deadlineMs
	);
	return status;
}
