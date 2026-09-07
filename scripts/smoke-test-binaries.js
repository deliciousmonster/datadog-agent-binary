#!/usr/bin/env node

// Proves a platform's built binaries are real before CI uploads them: the trace-agent must bind its
// receiver and count a real span, the core agent must start, identify itself, and stay up.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BINARIES, binaryFilename } from "../dist/src/binaries.js";
import { treeAt } from "../dist/src/layout.js";
import { currentTarget } from "../dist/src/targets.js";
import { debugVarsUrl } from "../runtime/delivery.js";
import { writeConfigFiles } from "../runtime/config.js";
import { receiverInfoUrl, verifyLaunch } from "../runtime/verify.js";
import { REPO_ROOT } from "./paths.js";
import { freshPorts } from "../test/support/loopback.js";
import { FAKE_API_KEY } from "../test/support/traffic.js";

// Go binaries bind well under a second cold; this only needs to be longer than a slow CI runner.
const DELIVERY_DEADLINE_MS = 15_000;
const DELIVERY_POLL_MS = 500;
// Long enough to catch an agent that binds its port, then panics on a config it doesn't like.
const LIVENESS_HOLD_MS = 3_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => console.log(`smoke-test: ${message}`);

// Same shape as test/live/harness.js's TRAFFIC_SCRIPT. flushInterval 0 skips dd-trace's own batching
// delay, so the span posts immediately instead of racing this script's poll deadline.
const SPAN_SCRIPT = `
const tracer = require('dd-trace').init({ startupLogs: false, flushInterval: 0 });
tracer.startSpan('smoke-test.span').finish();
`;

/** Spawns `binPath` and reports its exit in the shape runtime/verify.js's verifyLaunch expects. */
function spawnAgent(binPath, args) {
	const child = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
	const state = { pid: child.pid, exited: false, code: null, signal: null };
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.on("exit", (code, signal) => {
		state.exited = true;
		state.code = code;
		state.signal = signal;
	});
	return {
		child,
		state,
		output: () => `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
	};
}

/** Sleeps LIVENESS_HOLD_MS, then confirms `proc` (named by `label` in messages) is still running. */
async function holdAlive(proc, label) {
	await sleep(LIVENESS_HOLD_MS);
	if (proc.state.exited) {
		throw new Error(
			`${label} exited ${LIVENESS_HOLD_MS}ms into the liveness hold ` +
				`(code ${proc.state.code}, signal ${proc.state.signal})\n${proc.output()}`
		);
	}
	log(`${label} stayed up for ${LIVENESS_HOLD_MS}ms`);
}

/** Starts the trace-agent, proves it binds the receiver, then proves a real span reaches it. */
async function checkTraceAgent(binPath, ports, paths, resources, spawned) {
	log(`starting trace-agent: ${binPath} run -c ${paths.configFile}`);
	const proc = spawnAgent(binPath, ["run", "-c", paths.configFile]);
	spawned.push(proc.child);

	const context = { paths, ports };
	const bound = await verifyLaunch({ kind: "trace" }, proc.state, context);
	if (!bound.ok) {
		throw new Error(
			`did not bind ${receiverInfoUrl(ports.receiver)}: ${bound.detail}\n${proc.output()}`
		);
	}
	log(`trace-agent bound: ${bound.detail}`);

	try {
		execFileSync(process.execPath, ["-e", SPAN_SCRIPT], {
			cwd: REPO_ROOT,
			timeout: 20_000,
			env: {
				...process.env,
				DD_TRACE_AGENT_URL: `http://127.0.0.1:${ports.receiver}`,
				DD_TRACE_STARTUP_LOGS: "false",
				DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
				DD_REMOTE_CONFIGURATION_ENABLED: "false",
				DD_CRASHTRACKING_ENABLED: "false",
			},
		});
	} catch (error) {
		throw new Error(
			`sending a real span failed: ${error.message}\n${proc.output()}`
		);
	}

	log(`polling ${debugVarsUrl(ports.debug)} for the span to land`);
	const deadline = Date.now() + DELIVERY_DEADLINE_MS;
	let signal;
	do {
		signal = await resources.readDeliverySignal();
		if (signal.proven.tracesAtReceiver === true) break;
		await sleep(DELIVERY_POLL_MS);
	} while (Date.now() < deadline);

	if (signal?.proven?.tracesAtReceiver !== true) {
		throw new Error(
			`the span never showed up at the receiver within ${DELIVERY_DEADLINE_MS}ms ` +
				`(last read: ${JSON.stringify(signal)})\n${proc.output()}`
		);
	}
	log(
		`trace-agent counted it: ${signal.receiver.spansReceived} span(s) at the receiver`
	);

	await holdAlive(proc, "trace-agent");
}

/** Starts the core agent, proves it identifies itself over expvar, then proves it stays up. */
async function checkCoreAgent(binPath, ports, paths, _resources, spawned) {
	log(`starting core agent: ${binPath} run -c ${paths.runtimeDir}`);
	const proc = spawnAgent(binPath, ["run", "-c", paths.runtimeDir]);
	spawned.push(proc.child);

	const context = { paths, ports };
	const started = await verifyLaunch({ kind: "core" }, proc.state, context);
	if (!started.ok) {
		throw new Error(`did not start: ${started.detail}\n${proc.output()}`);
	}
	log(`core agent started: ${started.detail}`);

	await holdAlive(proc, "core agent");
}

// One entry per binary this repo ships, same signature on both, so a future binary with no entry here
// fails loudly rather than being checked by the wrong function.
const CHECKS = {
	"trace-agent": checkTraceAgent,
	"datadog-agent": checkCoreAgent,
};

// Windows answers a rename with EBUSY while anything still holds a handle inside the tree, and the
// build that just wrote it leaves handles open for a few seconds after it exits (an indexer, a
// scanner, the Go cache); the rename itself is right, only its moment is early.
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 1000;
async function rename(from, to) {
	for (let attempt = 1; ; attempt++) {
		try {
			return renameSync(from, to);
		} catch (error) {
			if (error.code !== "EBUSY" || attempt === RENAME_ATTEMPTS) throw error;
			log(
				`rename of ${from} is EBUSY (attempt ${attempt}); retrying in ${RENAME_RETRY_MS}ms`
			);
			await sleep(RENAME_RETRY_MS);
		}
	}
}

/** Moves the build tree's src/ aside so a binary that still links it by path can't find it. Reports
 * whether there was one: with no tree beside the bin dir, that independence is never put to the test. */
async function hideBuildTree(binDir) {
	const srcDir = treeAt(dirname(binDir)).source;
	const hiddenDir = `${srcDir}.smoke-test-hidden`;

	// A run killed between the rename below and its `finally` restore (a CI timeout, not a caught
	// throw) leaves hiddenDir behind with srcDir missing; recover it before this run hides anything.
	if (existsSync(hiddenDir) && !existsSync(srcDir))
		await rename(hiddenDir, srcDir);

	const hidden = existsSync(srcDir);
	if (hidden) await rename(srcDir, hiddenDir);
	return {
		hidden,
		srcDir,
		restore: async () => {
			if (hidden) await rename(hiddenDir, srcDir);
		},
	};
}

async function main() {
	const binDirArg = process.argv[2];
	if (!binDirArg) {
		console.error(
			"usage: node scripts/smoke-test-binaries.js <platform-bin-dir>"
		);
		process.exit(1);
	}
	const binDir = resolve(binDirArg);
	if (!existsSync(binDir)) {
		console.error(`smoke-test: no such directory: ${binDir}`);
		process.exit(1);
	}

	const isolation = await hideBuildTree(binDir);
	log(
		isolation.hidden
			? `hid the build tree at ${isolation.srcDir} for the duration of this run`
			: `no build tree at ${isolation.srcDir}, so nothing here tests independence from one`
	);
	// Declared out here so the finally below can remove it; everything the run creates is inside
	// the try, or a throw during setup strands the renamed build tree and the temp root.
	let rootDir;
	const spawned = [];
	const failures = [];
	try {
		rootDir = mkdtempSync(join(tmpdir(), "dd-smoke-test-"));
		const ports = await freshPorts();

		process.env.DD_API_KEY = FAKE_API_KEY;
		process.env.DD_SITE = process.env.DD_SITE || "datadoghq.com";
		process.env.DD_APM_RECEIVER_PORT = String(ports.receiver);
		process.env.DD_EXPVAR_PORT = String(ports.expvar);
		process.env.DD_APM_DEBUG_PORT = String(ports.debug);
		process.env.DD_DOGSTATSD_PORT = String(ports.dogstatsd);
		process.env.DD_CMD_PORT = String(ports.cmd);
		process.env.ROOTPATH = rootDir;

		// Dynamic, and after every env var above is set: resources.js reads DD_APM_*_PORT into module-scope
		// constants the moment it is evaluated, so a static import here would bind the wrong ports.
		const resources = await import("../resources.js");
		const runtime = resources.prepareRuntime();
		writeConfigFiles(runtime.configFiles, console);

		for (const binary of BINARIES) {
			const binPath = join(binDir, binaryFilename(binary, currentTarget()));
			const check = CHECKS[binary.shipsAs];
			if (!check) {
				failures.push(
					`${binary.shipsAs}: no smoke-test check registered for this binary`
				);
				continue;
			}
			if (!existsSync(binPath)) {
				failures.push(`${binary.shipsAs}: no binary at ${binPath}`);
				continue;
			}
			try {
				await check(binPath, ports, runtime.paths, resources, spawned);
			} catch (error) {
				failures.push(`${binary.shipsAs}: ${error.message}`);
			}
		}
	} finally {
		for (const child of spawned) {
			// A kill on a handle whose spawn failed has pid undefined, and node reads that as 0: SIGKILL to
			// this process group, which takes the release leg down with no output at all.
			if (!child.pid) continue;
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
		await isolation.restore();
		if (rootDir) rmSync(rootDir, { recursive: true, force: true });
	}

	if (failures.length > 0) {
		console.error(`smoke-test: FAILED for ${binDir}`);
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	log(
		`every binary in ${binDir} bound, ran, and delivered for real, ` +
			(isolation.hidden
				? "with its build tree hidden."
				: "though with no build tree hidden: build-tree independence went untested.")
	);
	process.exit(0);
}

main().catch((error) => {
	console.error(
		`smoke-test: unexpected failure: ${error.stack || error.message}`
	);
	process.exit(1);
});
