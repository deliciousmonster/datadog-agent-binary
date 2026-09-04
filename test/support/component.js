// Loading and driving resources.js the way Harper does. The module keeps per-thread start state and reads
// its ports once at load, so a suite that varies either needs its own instance rather than a shared import.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createRequire } from "node:module";

import { writeConfigFiles } from "../../runtime/config.js";
import { withEnvs } from "./sandbox.js";

const require = createRequire(import.meta.url);
const { REPO_ROOT, BINARIES, currentTarget } = require("./generator.js");

export { REPO_ROOT };

let instance = 0;

/** A fresh resources.js. The query string is what defeats the ES module cache. */
export function loadComponent() {
	const url = pathToFileURL(path.join(REPO_ROOT, "resources.js")).href;
	return import(`${url}?instance=${instance++}`);
}

/** A binary that exits at once, which is all a suite driving a recorded Harper ever runs. */
export const EXITS_AT_ONCE = "#!/bin/sh\nexit 0\n";

/**
 * A binary that stays up. Minutes, not seconds: this is spawned for real and stopped only by its own
 * caller's teardown (SIGTERM), so a lifetime long enough to outlast a slow, loaded machine is what keeps a
 * suite's own wall-clock from being able to race it.
 */
export const STAYS_UP = "#!/bin/sh\nexec sleep 300\n";

// runtime/binary.js's resolveBinary reads two fixed, shared locations, in order: the installed platform
// package under node_modules/, then build/<platform>/bin. Both paths are derived from resolveBinary's own
// file location, not from anything a caller here can redirect, so neither can be given a copy unique per
// call the way a temp-dir fixture would be. test/e2e/harper-component.test.js plants a fake platform
// package for its own file's duration; withBuiltBinaries plants build/<platform>/bin for one call's
// duration. Either one, present when it should not be, changes what a concurrent resolveBinary() call
// anywhere in the process tree resolves - so the one real fix is making sure only one user of these paths,
// across every file, is ever active at a time.
const RESOLVE_BINARY_LOCK = path.join(
	REPO_ROOT,
	"build",
	".resolveBinary.lock"
);
const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;

/**
 * Exclusive use of the paths resolveBinary() reads. `mkdirSync` without `recursive` fails EEXIST when
 * another holder already made the directory, which is what turns "wait your turn" into a real mutex
 * instead of a best-effort delay: a writer (withBuiltBinaries, or harper-component.test.js's fake platform
 * package) and a reader relying on those paths' absence or content can never observe each other mid-way,
 * in this process or another. Returns a `release` function rather than taking a callback, so a caller whose
 * hold must outlive one function - a whole test file's before()/after(), say - can still use it.
 */
export async function acquireResolveBinaryLock() {
	fs.mkdirSync(path.dirname(RESOLVE_BINARY_LOCK), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.mkdirSync(RESOLVE_BINARY_LOCK);
			return () =>
				fs.rmSync(RESOLVE_BINARY_LOCK, { recursive: true, force: true });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(
					`${RESOLVE_BINARY_LOCK} is still held after ${LOCK_TIMEOUT_MS}ms. A prior run likely ` +
						`crashed before releasing it; remove the directory by hand once nothing is using it.`
				);
			}
			await delay(LOCK_POLL_MS);
		}
	}
}

/** `run` under {@link acquireResolveBinaryLock}, released however `run` ends. */
export async function withResolveBinaryLock(run) {
	const release = await acquireResolveBinaryLock();
	try {
		return await run();
	} finally {
		release();
	}
}

/**
 * Both agent binaries where resources.js looks for a dev checkout's build output, for the duration of
 * `run`. The installed platform package predates the trace-agent and answers every request with the core
 * agent, so without these nothing that needs a trace-agent path can be driven at all.
 */
export async function withBuiltBinaries(run, body = EXITS_AT_ONCE) {
	return withResolveBinaryLock(async () => {
		const target = currentTarget();
		const binDir = path.join(REPO_ROOT, "build", target.name, "bin");
		fs.mkdirSync(binDir, { recursive: true });
		const files = BINARIES.map((binary) =>
			path.join(binDir, `${binary.shipsAs}${target.exe}`)
		);
		for (const file of files) {
			fs.writeFileSync(file, body);
			fs.chmodSync(file, 0o755);
		}
		try {
			return await run(files);
		} finally {
			for (const file of files) fs.rmSync(file, { force: true });
		}
	});
}

/**
 * The real agent binaries already at build/<platform>/bin, under the same exclusive lock
 * withBuiltBinaries takes. Unlike that fixture, nothing here writes them: the trace-agent and the core
 * agent are different bytes, so one `body` could never stand in for both, and `npm run build-agent`
 * is what has to have put them there first.
 */
export async function withRealBinaries(run) {
	return withResolveBinaryLock(async () => {
		const target = currentTarget();
		const binDir = path.join(REPO_ROOT, "build", target.name, "bin");
		const files = BINARIES.map((binary) =>
			path.join(binDir, `${binary.shipsAs}${target.exe}`)
		);
		const missing = files.filter((file) => !fs.existsSync(file));
		if (missing.length) {
			throw new Error(
				`real agent binaries are missing: ${missing.join(", ")}. Run \`npm run build-agent\` first.`
			);
		}
		return run(files);
	});
}

/**
 * Harper's process sidecar, recorded. `verify` runs against `state`, so a suite sets the state a real
 * Harper would report and reads back the verdict the component reached from it.
 */
export function recordingScope({ state = {} } = {}) {
	const starts = [];
	return {
		starts,
		processes: {
			async start(options) {
				starts.push(options);
				const processState = {
					started: true,
					adopted: false,
					pid: 4321,
					exited: false,
					...state,
				};
				const verdict = await options.verify(processState);
				return {
					...processState,
					verified: verdict.ok,
					verifyDetail: verdict.detail,
				};
			},
		},
	};
}

/** The start options recorded for one agent, by the spawn name Harper locks on. */
export const startFor = (scope, name) =>
	scope.starts.find((options) => options.name === name);

/**
 * Harper's native supervision, for real: unlike recordingScope's fabricated pid, this spawns
 * descriptor.command for real, writes descriptor.configFiles for real, and calls descriptor.verify
 * against the real child, so a real trace-agent/core-agent binary really has to bind its real port.
 * Every child lands on `.children` so a caller's teardown can stop them all. `logDir` is where each
 * child's stdout/stderr goes, since nothing here reads those streams and an unread pipe can stall a
 * chatty binary's own write() - the same gap test/live/harness.js's own real-spawn site closes.
 */
export function nativeScope({ logDir }) {
	const children = [];
	return {
		children,
		processes: {
			// A real Harper reaper would sit here; explicit null says this fixture never runs one,
			// rather than leaving harperSupervisor to read an accidental `undefined`.
			reaper: null,
			async start(descriptor) {
				writeConfigFiles(descriptor.configFiles, console);
				const logFd = fs.openSync(
					path.join(logDir, `${descriptor.name}.log`),
					"a"
				);
				const child = spawn(descriptor.command, descriptor.args, {
					stdio: ["ignore", logFd, logFd],
				});
				// The child's dup2'd copy survives this: closing the parent's own fd frees it without
				// touching whatever the child now holds open on the same file.
				fs.closeSync(logFd);
				children.push(child);
				const state = {
					name: descriptor.name,
					title: descriptor.title,
					command: descriptor.command,
					started: true,
					pid: child.pid,
					exited: false,
					adopted: false,
				};
				// An unhandled 'error' event crashes the process (guard/src/index.js:128,
				// guard/src/supervise.js:195,211); reported the same way the 'exit' listener below does.
				child.on("error", () => {
					state.exited = true;
				});
				// Mutated in place: descriptor.verify's giveUp() reads this same object mid-poll, so a
				// death after start() returns still has to reach it, not a snapshot taken before it.
				child.on("exit", (code, signal) => {
					state.exited = true;
					state.code = code;
					state.signal = signal;
				});
				const verdict = await descriptor.verify(state);
				return { ...state, verified: verdict.ok, verifyDetail: verdict.detail };
			},
		},
	};
}

/** Start the component against a scope and hand back the recorded starts plus the status resource. */
export async function start(scope, componentEnv = {}) {
	return withEnvs(componentEnv, async () => {
		const { handleApplication, DatadogStatus } = await loadComponent();
		handleApplication(scope);
		return { status: await DatadogStatus.get(), DatadogStatus };
	});
}
