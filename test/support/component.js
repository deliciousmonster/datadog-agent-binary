// Loading and driving resources.js the way Harper does. The module keeps per-thread start state and reads
// its ports once at load, so a suite that varies either needs its own instance rather than a shared import.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createRequire } from "node:module";

import { PACKAGE_NAME } from "../../runtime/datadog.js";
import { writeConfigFiles } from "../../runtime/datadog.js";
import { withEnvs } from "./sandbox.js";

const require = createRequire(import.meta.url);
const {
	REPO_ROOT,
	BINARIES,
	binariesFor,
	currentTarget,
} = require("./repo.js");

export { REPO_ROOT };

let instance = 0;

/** A fresh resources.js. The query string is what defeats the ES module cache. */
export function loadComponent() {
	const url = pathToFileURL(path.join(REPO_ROOT, "resources.js")).href;
	return import(`${url}?instance=${instance++}`);
}

// Stamped into every stub this module writes, and the only thing isFixtureStub looks for. Recognising a
// stub by its marker rather than by matching a list of known bodies is what keeps the two from drifting.
const STUB_MARKER = "written-by-withBuiltBinaries";

/** The shell stub this module writes at a built-binary path, running `command`. */
export const stub = (command) => `#!/bin/sh\n# ${STUB_MARKER}\n${command}\n`;

/**
 * A planted binary a spawn cannot run, for a test that needs one. The shebang names a missing interpreter,
 * so execve answers ENOENT: a body with no `#!` gives ENOEXEC instead, which glibc retries under /bin/sh,
 * and the spawn then succeeds on Linux while failing on darwin. Stamped, so a run killed holding it does
 * not read as a build made since.
 */
export const UNEXECUTABLE = `#!/nonexistent/interpreter\n# ${STUB_MARKER}\n`;

/** A binary that exits at once, which is all a suite driving a recorded Harper ever runs. */
const EXITS_AT_ONCE = "exit 0";

/**
 * A binary that stays up. Minutes, not seconds: this is spawned for real and stopped only by its own
 * caller's teardown (SIGTERM), so a lifetime long enough to outlast a slow, loaded machine is what keeps a
 * suite's own wall-clock from being able to race it.
 */
export const STAYS_UP = "exec sleep 300";

// runtime/datadog.js's resolveBinary reads two fixed, shared locations, in order: the installed platform
// package under node_modules/, then build/<platform>/bin. Both paths are derived from resolveBinary's own
// file location, not from anything a caller here can redirect, so neither can be given a copy unique per
// call the way a temp-dir fixture would be. test/unit/harper-component.test.js plants a fake platform
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
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST")
				throw error;
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
async function withResolveBinaryLock(run) {
	const release = await acquireResolveBinaryLock();
	try {
		return await run();
	} finally {
		release();
	}
}

/** Whether `file` is a stub this module left behind, and so safe to discard rather than a real build. */
function isFixtureStub(file) {
	// Total rather than throwing: an absent file gives an undefined size, which fails the comparison and
	// short-circuits the read. A real agent is tens of megabytes and never reaches it either.
	const { size } = fs.statSync(file, { throwIfNoEntry: false }) ?? {};
	return size <= 256 && fs.readFileSync(file, "utf8").includes(STUB_MARKER);
}

/** Where a dev checkout's `npm run build-agent` leaves each agent, which is also where stubs go. */
export function builtBinaryPaths() {
	const target = currentTarget();
	const binDir = path.join(REPO_ROOT, "build", target.name, "bin");
	return {
		binDir,
		// binariesFor, not BINARIES: system-probe is Linux-only and security-agent has no macOS build, so
		// planting them on a Mac would stage paths no build ever writes there.
		files: binariesFor(target).map((binary) =>
			path.join(binDir, `${binary.shipsAs}${target.exe}`)
		),
	};
}

/**
 * Whatever sits at `files` moved aside, and the restore that puts it back. A rename, so a 139MB agent
 * costs the same as an empty file and the mode rides along with the inode; copying the bytes back would
 * drop the exec bit and leave an agent nothing can spawn. Takes its paths so a test can drive it against
 * a temp dir rather than having to stage an interrupted run over a developer's real build.
 */
export function hideFiles(files) {
	const hidden = files.map((file) => `${file}.hidden-by-fixture`);
	files.forEach((file, index) => {
		// A run killed after writing its stub left that stub at the real path and the build at the hidden
		// copy; hiding the stub over it is what loses the build, and discarding it leaves the build where
		// the restore below finds it. A run killed before writing one needs nothing: that restore recovers
		// the hidden copy whether or not anything was hidden this time.
		if (fs.existsSync(hidden[index]) && isFixtureStub(file)) fs.rmSync(file);
		else if (fs.existsSync(file)) fs.renameSync(file, hidden[index]);
	});
	return () =>
		files.forEach((file, index) => {
			fs.rmSync(file, { force: true });
			if (fs.existsSync(hidden[index])) fs.renameSync(hidden[index], file);
		});
}

/**
 * The same binaries inside an installed platform package, which resolveBinary consults BEFORE
 * build/<platform>/bin. Empty unless the optional dependency for this platform is installed, which a
 * clean `npm install` does: a fixture that hides only the build output is shadowed by these.
 */
function installedPlatformBinaries() {
	const target = currentTarget();
	const binDir = path.join(
		REPO_ROOT,
		"node_modules",
		`${PACKAGE_NAME}-${target.name}`,
		"bin"
	);
	return BINARIES.map((binary) =>
		path.join(binDir, `${binary.shipsAs}${target.exe}`)
	).filter((file) => fs.existsSync(file));
}

/** Every path resolveBinary would answer with, hidden together so only a fixture's own stubs resolve. */
export const hideBuiltBinaries = () =>
	hideFiles([...installedPlatformBinaries(), ...builtBinaryPaths().files]);

/**
 * Both agent binaries where resources.js looks for a dev checkout's build output, for the duration of
 * `run`. The installed platform package predates the trace-agent and answers every request with the core
 * agent, so without these nothing that needs a trace-agent path can be driven at all.
 */
export async function withBuiltBinaries(run, command = EXITS_AT_ONCE) {
	return withResolveBinaryLock(() => plantBuiltBinaries(run, command));
}

/**
 * {@link withBuiltBinaries} without the lock, for the one caller that has to hold it across more than this
 * call: test/unit/built-binaries-fixture.test.js stages the paths this plants at, and that staging is
 * as visible to a concurrent resolveBinary() as the stubs are.
 */
export async function plantBuiltBinaries(run, command = EXITS_AT_ONCE) {
	const { binDir, files } = builtBinaryPaths();
	fs.mkdirSync(binDir, { recursive: true });
	// A developer's real build lives at these exact paths, so the stubs written over it have to give it
	// back: deleting instead means running this suite destroys an `npm run build-agent` as a side effect.
	const restore = hideBuiltBinaries();
	for (const file of files) {
		// "wx", not the default truncating write: if the hide above ever stops running, this fails EEXIST
		// instead of emptying a 139MB agent in place, which no hardlink or backup taken beforehand survives.
		fs.writeFileSync(file, stub(command), { flag: "wx" });
		fs.chmodSync(file, 0o755);
	}
	try {
		return await run(files);
	} finally {
		restore();
	}
}

/**
 * The real agent binaries already at build/<platform>/bin, under the same exclusive lock
 * withBuiltBinaries takes. Unlike that fixture, nothing here writes them: the trace-agent and the core
 * agent are different bytes, so one `body` could never stand in for both, and `npm run build-agent`
 * is what has to have put them there first.
 */
export async function withRealBinaries(run) {
	return withResolveBinaryLock(async () => {
		const { files } = builtBinaryPaths();
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

/** Path to the guard's pid lock file for one agent under `pidDir`, read by both recordingScope- and nativeScope-driven suites to check what the guard actually did. */
export const lockFile = (pidDir, name) => path.join(pidDir, `${name}.pid`);

/** The pid a guard lock records, or null. Line 1 is the pid; a host reading only that still reads it. */
export function lockedPid(pidDir, name) {
	try {
		const first = fs
			.readFileSync(lockFile(pidDir, name), "utf-8")
			.split("\n")[0];
		return Number.parseInt(first, 10);
	} catch {
		return null;
	}
}

// SIGTERM, not SIGKILL: the guard reads a signalled stop as deliberate and releases its lock instead
// of restarting, so teardown here cannot race the supervision a caller just started.
export function halt(pid) {
	if (!Number.isInteger(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
}

/** Polls until every named lock under `pidDir` is gone, so a caller's teardown never races a release still writing the runtime tree it sits in. */
export async function waitForLocksCleared(pidDir, names) {
	for (let i = 0; i < 300; i++) {
		if (names.every((name) => !fs.existsSync(lockFile(pidDir, name)))) return;
		await delay(10);
	}
}

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
				// An unhandled 'error' event crashes the process, which is why the guard's own launchReaper()
				// and attempt() attach one right after ctx.spawn(); reported the way the 'exit' listener is.
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
