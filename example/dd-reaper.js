/**
 * Stops the Datadog agents when the Harper node that started them goes away.
 *
 * Run as its own process, spawned by dd-supervisor.js through the same constrained `spawn`
 * the agents use, so Harper's PID-file lock makes it one per node. It is not imported.
 *
 * **Why a separate process at all.** Harper v5 offers a component no node-shutdown hook, and
 * the one lifecycle hook it does offer fires on exactly the event the agents must survive.
 * Read against 5.2.6:
 *
 * - `harper stop` sends one SIGTERM to one PID, the main process named in `<root>/hdb.pid`
 *   (`bin/stop.js`, `utility/environment/systemInformation.js`). Not a process group, and
 *   nothing is sent to worker threads.
 * - The main process's SIGTERM handler is `beginProcessShutdown(); removeHdbPid();
 *   process.exit(0)` (`bin/run.js`). `beginProcessShutdown()` sets one boolean
 *   (`server/threads/manageThreads.js`); no worker is told anything.
 * - A worker thread's own `process.on('exit')` does not run when the main process exits, is
 *   terminated, or takes a signal. Measured on Node v24.16.0: of `worker.terminate()`,
 *   `process.exit(0)` on main, and SIGTERM to main, none fire the worker's handler, while the
 *   worker calling `process.exit()` itself does.
 * - `scope.on('close')` (`components/Scope.js`) is real, but its only trigger is the SHUTDOWN
 *   ITC message, and the only sender is `restartWorkers` (`manageThreads.js`), which serves
 *   worker recycle and `harper restart`. So it fires when the agents must live and stays
 *   silent when they must die.
 *
 * That leaves out-of-process, which is what Harper does for its own subprocesses: it registers
 * their process group and SIGKILLs it from the main process's `exit` handler
 * (`manageThreads.js`). That mechanism is internal and unreachable from a component, so this
 * file is the same idea with the parts a component can reach.
 *
 * **Why the parent PID is the right thing to watch.** Worker threads share one process, so a
 * `spawn` from a worker produces a child of the *main* Harper process. `process.ppid` here is
 * Harper's PID, and its disappearance is the node's death. A recycled worker thread does not
 * change it, which is the whole point.
 *
 * **The grace window.** `harper restart` removes `hdb.pid`, forks a fresh main process and
 * exits the old one (`bin/restart.js`), so the parent dies on a path where the agents should
 * be kept and adopted by the new node. After the parent goes, this waits for a new `hdb.pid`
 * to appear before reaping. It also keeps the reap from racing a new node's workers into the
 * PID files, which is the failure that does not heal: a worker that adopts a PID this process
 * is about to kill joins a corpse and reports "already running" forever.
 *
 * Not covered: SIGKILL to the Harper main process leaves `hdb.pid` behind, since the handler
 * that removes it never runs. This still reaps, because the parent is gone and the PID in the
 * stale file is not alive.
 */

import { existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/** How often to check whether the parent is still there. */
const POLL_INTERVAL_MS = 1000;

/** How long an agent gets after SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 5000;

function parseArgs(argv) {
	const options = { agents: [] };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		switch (argv[i]) {
			case '--harper-pid':
				options.harperPid = Number.parseInt(value, 10);
				i++;
				break;
			case '--hdb-pid-file':
				options.hdbPidFile = value;
				i++;
				break;
			case '--restart-grace-ms':
				options.restartGraceMs = Number.parseInt(value, 10);
				i++;
				break;
			case '--log':
				options.logFile = value;
				i++;
				break;
			case '--self-pid-file':
				options.selfPidFile = value;
				i++;
				break;
			// `--agent <pidFile>:<pid>`, repeatable. Both halves are kept: the file is the
			// node's live record and the number is what this process actually watched start.
			case '--agent': {
				const separator = value.lastIndexOf(':');
				options.agents.push({
					pidFile: value.slice(0, separator),
					pid: Number.parseInt(value.slice(separator + 1), 10),
				});
				i++;
				break;
			}
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));

/**
 * Its own log file. stdio is inherited as `ignore` from the supervisor's spawn, deliberately:
 * a pipe would tie this process to the worker thread that won the spawn race, and that thread
 * is recycled routinely.
 */
const logFd = options.logFile ? openSync(options.logFile, 'a') : null;

function log(message) {
	const line = `${new Date().toISOString()} [dd-reaper ${process.pid}] ${message}\n`;
	if (logFd === null) process.stdout.write(line);
	else writeSync(logFd, line);
}

function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists and belongs to someone else. Harper and the agents
		// run as the same user here, so this should not happen, but reading it as "gone"
		// would reap a live node.
		return error.code === 'EPERM';
	}
}

/** Line 1 of a Harper PID file, or NaN. */
function readPidFile(path) {
	try {
		return Number.parseInt(readFileSync(path, 'utf-8').split('\n')[0], 10);
	} catch {
		return Number.NaN;
	}
}

function removeQuietly(path) {
	try {
		unlinkSync(path);
	} catch {
		// Already gone, which is the state we wanted.
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a new Harper has taken over since the parent died. `harper restart` forks a
 * replacement that writes its own `hdb.pid`; `harper stop` leaves nothing behind.
 */
function replacementHarperPid() {
	if (!options.hdbPidFile || !existsSync(options.hdbPidFile)) return null;
	const pid = readPidFile(options.hdbPidFile);
	if (pid === options.harperPid || !isAlive(pid)) return null;
	return pid;
}

/**
 * Stop one agent. The PID file is removed first: a file naming a process that is being killed
 * is worse than no file, because a worker that reads it adopts a corpse and never retries,
 * while a worker that finds nothing spawns a fresh agent.
 */
async function reapAgent({ pidFile, pid }) {
	const recorded = readPidFile(pidFile);
	removeQuietly(pidFile);

	// Both, when they disagree. `recorded` is the node's live record and is what Harper
	// itself would adopt; `pid` is what this process watched start. They differ only if the
	// agent was replaced after this process began, and in that case leaving either alive is
	// the defect being fixed. PID reuse in the seconds between the node dying and this
	// running is possible in principle and has never been observed.
	const targets = [...new Set([recorded, pid])].filter(isAlive);
	if (targets.length === 0) {
		log(`${pidFile}: nothing alive to stop`);
		return;
	}

	for (const target of targets) {
		try {
			process.kill(target, 'SIGTERM');
			log(`sent SIGTERM to ${target} (${pidFile})`);
		} catch (error) {
			log(`could not SIGTERM ${target}: ${error.message}`);
		}
	}

	const deadline = Date.now() + TERM_GRACE_MS;
	while (Date.now() < deadline && targets.some(isAlive)) await sleep(100);

	for (const target of targets.filter(isAlive)) {
		try {
			process.kill(target, 'SIGKILL');
			log(`${target} ignored SIGTERM for ${TERM_GRACE_MS}ms; sent SIGKILL`);
		} catch (error) {
			log(`could not SIGKILL ${target}: ${error.message}`);
		}
	}
}

async function main() {
	if (!Number.isInteger(options.harperPid)) {
		log('no --harper-pid was given, so there is nothing to watch. Exiting.');
		process.exit(2);
	}

	log(
		`watching Harper pid ${options.harperPid}; will stop ${options.agents.length} agent(s) ` +
			`when it goes away. Restart grace ${options.restartGraceMs ?? 0}ms.`
	);

	while (isAlive(options.harperPid)) await sleep(POLL_INTERVAL_MS);
	log(`Harper pid ${options.harperPid} is gone.`);

	const graceDeadline = Date.now() + (options.restartGraceMs ?? 0);
	while (Date.now() < graceDeadline) {
		const replacement = replacementHarperPid();
		if (replacement !== null) {
			log(`a replacement Harper (pid ${replacement}) took over; leaving the agents for it to adopt.`);
			// Its own lock has to go, or the new node cannot start a reaper of its own: the
			// PID file would name this process, which is about to exit.
			if (options.selfPidFile) removeQuietly(options.selfPidFile);
			process.exit(0);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	for (const agent of options.agents) await reapAgent(agent);
	if (options.selfPidFile) removeQuietly(options.selfPidFile);
	log('done.');
	process.exit(0);
}

main().catch((error) => {
	log(`failed: ${error?.stack ?? error}`);
	process.exit(1);
});
