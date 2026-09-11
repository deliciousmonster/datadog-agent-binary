#!/usr/bin/env node

// Proves a platform's built binaries are real before CI uploads them: the trace-agent must bind its
// receiver and count a real span, the core agent must start, identify itself, and stay up.
//
// Under test/binaries/ because it is what that tier is: real binaries from build/<target>/bin, driven for
// real. It reaches for runtime/verify.js rather than writing a second, weaker idea of what a working agent
// looks like, and the release workflow runs it on every leg before anything is uploaded.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo root, from this file rather than from a module whose only job was to say it four different ways.
// test/binaries/, so two hops to the root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { binariesFor, binaryFilename } from "../../agent-build/binaries.js";
import { pinnedVersion } from "../../agent-build/download.js";
import { treeAt } from "../../agent-build/tree.js";
import { currentTarget } from "../../agent-build/toolchain.js";
import {
	debugVarsUrl,
	receiverInfoUrl,
	writeConfigFiles,
} from "../../runtime/datadog.js";
import { verifyLaunch } from "../../runtime/verify.js";

import { freshPorts } from "../support/loopback.js";
import { driveTraffic, FAKE_API_KEY } from "../support/traffic.js";

// Go binaries bind well under a second cold; this only needs to be longer than a slow CI runner.
const DELIVERY_DEADLINE_MS = 15_000;
const DELIVERY_POLL_MS = 500;
// Long enough to catch an agent that binds its port, then panics on a config it doesn't like.
const LIVENESS_HOLD_MS = 3_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => console.log(`smoke-test: ${message}`);

// The mechanism is support/traffic.js's, shared with the equivalence suite and the live tier; only the
// span naming is this file's own. It carried its own copy of the script before, under a comment saying it
// was the same shape as the one it could have imported.
const SPAN_SCRIPT = {
	envVar: "SMOKE_SPAN_COUNT",
	spanName: "smoke-test.span",
	tagKey: "smoke.iteration",
};

/** Spawns `binPath` and reports its exit in the shape runtime/component.js's verifyLaunch expects. */
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
		driveTraffic(ports.receiver, 1, SPAN_SCRIPT);
	} catch (error) {
		throw new Error(
			`sending a real span failed: ${/** @type {Error} */ (error).message}\n${proc.output()}`
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
/**
 * What can be proven about a binary that needs privileges this runner does not have.
 *
 * system-probe loads eBPF programs or opens kernel drivers, and security-agent talks to system-probe
 * over a socket; neither can start usefully on a CI runner, and pretending otherwise would make this
 * check pass on a binary that cannot run at all. What `version` proves is real and is what would have
 * caught the one that mattered: a macOS system-probe built with the wrong Go toolchain panicked before
 * main with `strcase.UnicodeVersion "15.0.0" != unicode.Version "17.0.0"`, and it packaged, and it
 * passed the publish gate's symbol check. A binary that dies at init cannot print its version.
 */
export const versionArgv = (extraArgs = []) => ["version", ...extraArgs];

async function checkReportsVersion(
	binPath,
	_ports,
	paths,
	_resources,
	_spawned,
	extraArgs = []
) {
	const wanted = (await pinnedVersion()) ?? "";
	const argv = versionArgv(extraArgs);
	log(`asking ${binPath} for its version as ${argv.join(" ")}`);
	const reported = await new Promise((resolve) => {
		const child = spawn(binPath, argv, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout?.on("data", (chunk) => (out += chunk));
		child.stderr?.on("data", (chunk) => (out += chunk));
		child.on("error", (error) => resolve(`did not execute: ${error.message}`));
		child.on("close", () => resolve(out.trim()));
	});
	if (!wanted)
		throw new Error(
			".datadog-agent-version is absent, so nothing says what it should report"
		);
	if (!reported.includes(wanted))
		throw new Error(
			`reported ${JSON.stringify(reported.slice(0, 200))}, which does not carry the pinned ${wanted}`
		);
	log(`reports ${wanted}: ${reported.split("\n")[0]}`);
}

export const CHECKS = {
	"trace-agent": checkTraceAgent,
	"datadog-agent": checkCoreAgent,
	// Started for real would need CAP_SYS_ADMIN and an object matching the runner's kernel on Linux, a
	// /dev/bpf device on macOS, and two kernel drivers on Windows. None of those is a runner.
	"system-probe": checkReportsVersion,
	// security-agent loads a config even to print its version, where system-probe does not: without one
	// it answers `unable to load Datadog config file: Config File Not Found` and never reaches the
	// version. --cfgpath takes the directory, which is the form both it and process-agent accept and the
	// one the supervisor already passes them; `-c <file>` works too and is the flag CI saw fail.
	"security-agent": (binPath, ports, paths, resources, spawned) =>
		checkReportsVersion(binPath, ports, paths, resources, spawned, [
			"--cfgpath",
			paths.runtimeDir,
		]),
	// process-agent answers bare, and is given the same directory anyway so the three agree.
	"process-agent": (binPath, ports, paths, resources, spawned) =>
		checkReportsVersion(binPath, ports, paths, resources, spawned, [
			"--cfgpath",
			paths.runtimeDir,
		]),
};

// Windows answers a rename with EBUSY while anything holds a handle inside the tree. On the CI runner
// the build's tree stays busy for the whole ten seconds this waits, and nothing here can see by what.
// Returns whether the rename happened: on Windows a tree still busy after the retries is reported
// and left in place, so the binaries are still proven to bind and serve there and only their
// independence from the tree goes untested on that one platform. Anywhere else it is a failure.
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 1000;
async function rename(from, to) {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return true;
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EBUSY")
				throw error;
			if (attempt === RENAME_ATTEMPTS) {
				if (process.platform !== "win32") throw error;
				log(
					`${from} stayed EBUSY for ${(RENAME_ATTEMPTS * RENAME_RETRY_MS) / 1000}s; Windows keeps it in place`
				);
				return false;
			}
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

	const hidden = existsSync(srcDir) && (await rename(srcDir, hiddenDir));
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
		console.error("usage: node test/binaries/smoke.js <platform-bin-dir>");
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
			: `the build tree at ${isolation.srcDir} is absent or could not be moved, so nothing here tests independence from it`
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
		const resources = await import("../../resources.js");
		const runtime = resources.prepareRuntime();
		writeConfigFiles(runtime.configFiles, console);

		// binariesFor, not BINARIES: system-probe and security-agent are not on every platform, and macOS
		// builds no security-agent at all. Asking for one that was never built fails the smoke test for a
		// binary this platform is not supposed to have.
		for (const binary of binariesFor(currentTarget())) {
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
				failures.push(
					`${binary.shipsAs}: ${/** @type {Error} */ (error).message}`
				);
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

// Guarded so a test can import CHECKS and versionArgv without the script running a build it has no
// binaries for. The argv this builds went untested until CI proved it: checkReportsVersion took an
// extraArgs parameter, both call sites passed one, and the spawn ignored it, so security-agent was
// asked bare on every platform and answered with the config it could not find.
const invokedDirectly =
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly)
	main().catch((error) => {
		console.error(
			`smoke-test: unexpected failure: ${error.stack || error.message}`
		);
		process.exit(1);
	});
