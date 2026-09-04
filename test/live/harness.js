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
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { PACKAGE_NAME, resolveBinary } from "../../runtime/binary.js";
import { REPO_ROOT } from "../support/generator.js";
import { findFreePort } from "../support/loopback.js";
import { driveTraffic as driveTrafficWith } from "../support/traffic.js";

const COMPONENT_NAME = basename(REPO_ROOT);

// The same table resources.js's own AGENTS array and scripts/create-platform-packages.js build
// from, so a binary added there is resolved here without this file naming it separately.
const { BINARIES } = await import(
	join(REPO_ROOT, "dist", "src", "binaries.js")
);

const ADMIN_USER = "LIVE_ADMIN";
const ADMIN_PASS = "live-tier-2026";

// Syntactically valid, not real. A wrong key still makes the trace-agent build and count real
// payloads before the intake refuses them; an unset key disables the forwarder and proves nothing.
const FAKE_API_KEY = "0".repeat(32);

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
		name: "harper@5.2.8 / guard-bundled supervision",
		harperLine: "5.2.8",
		moduleLoader: "vm-current-context",
		expectedSupervision: "guard",
	},
	{
		// A local worktree, not the registry: this Harper build carries a real `scope.processes`
		// (feat/process-guard), so this row proves the native path rather than mocking it.
		name: "harper@5.2.5 (patched) / native scope.processes supervision",
		harperLine: "file:/Users/jrepp/Developer/repositories/harperfast/.wt/guard",
		moduleLoader: "vm-current-context",
		expectedSupervision: "harper",
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

/** Throws rather than lets a bug boot Harper against the operator's real install. */
function assertSafeHome(home, realHome) {
	if (home === realHome || !home.startsWith(tmpdir())) {
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
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`harper run exited (code ${child.exitCode}) before the trace-agent verified; see its log`
			);
		}
		const status = await fetchJson(statusUrl, authHeader).catch(() => null);
		const trace = status?.processes?.find(
			(process) => process.kind === "trace"
		);
		if (trace?.verified) return status;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`the trace-agent did not verify within ${deadlineMs}ms`);
}

/**
 * Generates a throwaway fixture app, npm-installs a real Harper plus this repo into it, resolves
 * the real agent binaries, writes the fixture's own root config, and boots `harper run` as a
 * detached child. Returns once the real trace-agent has verified over real HTTP.
 */
export async function bootHarper(row) {
	const realHome = process.env.HOME;
	const workDir = mkdtempSync(join(tmpdir(), "dd-live-"));
	// Reassigned once spawned, so a failure between spawn and readiness still kills the real child
	// this function started rather than leaking it.
	let child;
	try {
		return await bootHarperInto(workDir, row, realHome, (spawned) => {
			child = spawned;
		});
	} catch (error) {
		if (child) killTree(child.pid);
		rmSync(workDir, { recursive: true, force: true });
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
				dependencies: { [PACKAGE_NAME]: `file:${REPO_ROOT}` },
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
	const [corePath, tracePath] = await Promise.all(
		BINARIES.map((binary) =>
			resolveBinary({ shipsAs: binary.shipsAs, title: binary.shipsAs })
		)
	);

	// Confirmed against this repo's own runtime/config.js: HOME is what os.homedir() (and so
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
			allowedBinaries: [corePath, tracePath],
		})
	);
	mkdirSync(join(hdbRoot, "components"), { recursive: true });
	symlinkSync(REPO_ROOT, join(hdbRoot, "components", COMPONENT_NAME));
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
			rmSync(workDir, { recursive: true, force: true });
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
 * Polls DatadogStatus until the real receiver reports exactly `count` traces delivered and the
 * verdict has left "idle" (a periodic stats bucket, not an on-write counter, so a fresh burst can
 * sit at the right count with a stale "idle" verdict for several seconds), or the deadline passes.
 * Returns the last status read, which is `undefined` only if DatadogStatus never answered at all.
 */
export async function waitForDelivery(handle, count, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	let status;
	while (Date.now() < deadline) {
		status = await readDelivery(handle).catch(() => status);
		if (
			status?.delivery?.receiver.tracesReceived === count &&
			status.delivery.verdict !== "idle"
		) {
			return status;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return status;
}
