/**
 * dd-reaper.js against stand-in processes: what makes it fire, and what must not.
 *
 * The defect is that the Datadog agents outlive `harper stop`. The constraint that made it
 * non-trivial is that agent lifetime is deliberately decoupled from the worker thread that won
 * the spawn race, because Harper recycles that thread and the agents must survive it. So the
 * two claims worth proving are opposites, and both are here: the reaper stops the agents when
 * the process it watches dies, and it does nothing at all while that process lives.
 *
 * Harper is not booted here. `test/integration/harper-spawn.test.ts` runs the same two claims
 * against a real node, where the recycle is a real `restart_service` and the shutdown is the
 * SIGTERM `harper stop` sends. This file is the fast, hermetic half, and it can produce cases
 * a real node makes expensive: a replacement Harper appearing inside the grace window, a PID
 * file naming a process that is already gone, an agent that ignores SIGTERM.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { REPO_ROOT, makeTempDir } from '../support/harness.js';

const REAPER = path.join(REPO_ROOT, 'example', 'dd-reaper.js');

/** Stands in for a process the reaper watches or kills: alive until signalled. */
const LONG_LIVED = 'setInterval(() => {}, 60000);';

/** Ignores SIGTERM, so the escalation to SIGKILL is exercised rather than assumed. */
const STUBBORN = "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);";

/** Everything started here, so a failed assertion cannot leak a process into the next run. */
const started = [];

after(() => {
	for (const child of started) {
		try {
			child.kill('SIGKILL');
		} catch {
			// already gone
		}
	}
});

function startStub(source = LONG_LIVED) {
	const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
	started.push(child);
	return child;
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate, { timeoutMs = 20000, intervalMs = 50 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

/**
 * A Harper root with a `pids/` directory, an `hdb.pid`, and one PID file per agent, in the
 * two-line shape Harper writes (pid, then the numeric version).
 */
function makeRoot({ harperPid, agents }) {
	const root = makeTempDir('ddab-reaper-');
	fs.mkdirSync(path.join(root, 'pids'), { recursive: true });
	fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
	if (harperPid !== undefined) fs.writeFileSync(path.join(root, 'hdb.pid'), String(harperPid));
	for (const [name, pid] of Object.entries(agents)) {
		fs.writeFileSync(path.join(root, 'pids', `${name}.pid`), `${pid}\n2147189108`);
	}
	return root;
}

function startReaper(root, { harperPid, agents, graceMs = 0 }) {
	const args = [
		REAPER,
		'--harper-pid',
		String(harperPid),
		'--hdb-pid-file',
		path.join(root, 'hdb.pid'),
		'--restart-grace-ms',
		String(graceMs),
		'--self-pid-file',
		path.join(root, 'pids', 'datadog-agent-reaper.pid'),
		'--log',
		path.join(root, 'logs', 'reaper.log'),
	];
	for (const name of Object.keys(agents)) {
		args.push('--agent', `${path.join(root, 'pids', `${name}.pid`)}:${agents[name]}`);
	}
	const child = spawn(process.execPath, args, { stdio: 'ignore' });
	started.push(child);
	fs.writeFileSync(path.join(root, 'pids', 'datadog-agent-reaper.pid'), `${child.pid}\n2147189108`);
	return child;
}

test('the agents are stopped when the process the reaper watches goes away', async () => {
	const harper = startStub();
	const trace = startStub();
	const core = startStub();
	const agents = { 'datadog-trace-agent': trace.pid, 'datadog-agent': core.pid };
	const root = makeRoot({ harperPid: harper.pid, agents });
	const reaper = startReaper(root, { harperPid: harper.pid, agents });

	// The PID files exist and name live processes: the state a node is in while it is up.
	assert.ok(isAlive(trace.pid) && isAlive(core.pid));

	harper.kill('SIGKILL');
	assert.ok(await waitUntil(() => !isAlive(harper.pid)), 'the stand-in Harper did not exit');

	assert.ok(await waitUntil(() => !isAlive(trace.pid)), 'the trace-agent outlived the node');
	assert.ok(await waitUntil(() => !isAlive(core.pid)), 'the core agent outlived the node');

	// The PID files are the other half of the defect: they survive and name live processes,
	// so anything reading them believes the node still has agents.
	for (const name of [...Object.keys(agents), 'datadog-agent-reaper']) {
		const file = path.join(root, 'pids', `${name}.pid`);
		assert.ok(await waitUntil(() => !fs.existsSync(file)), `${file} was left behind`);
	}
	assert.ok(await waitUntil(() => !isAlive(reaper.pid)), 'the reaper did not exit after reaping');
	fs.rmSync(root, { recursive: true, force: true });
});

test('NEGATIVE: nothing is stopped while the watched process is alive', async () => {
	// This is the case the naive fix breaks. Agent lifetime is decoupled from the worker
	// thread on purpose, so a reaper that fires on anything short of the node's death
	// reintroduces the bug it was written to prevent.
	const harper = startStub();
	const trace = startStub();
	const agents = { 'datadog-trace-agent': trace.pid };
	const root = makeRoot({ harperPid: harper.pid, agents });
	startReaper(root, { harperPid: harper.pid, agents });

	// Several poll intervals. The reaper checks once a second.
	await sleep(3500);

	assert.ok(isAlive(trace.pid), 'the trace-agent was stopped while the node was still up');
	assert.ok(
		fs.existsSync(path.join(root, 'pids', 'datadog-trace-agent.pid')),
		'the PID file was removed while the node was still up'
	);

	harper.kill('SIGKILL');
	trace.kill('SIGKILL');
	fs.rmSync(root, { recursive: true, force: true });
});

test('a replacement node inside the grace window keeps the agents, for it to adopt', async () => {
	// `harper restart` forks a fresh main process and exits the old one, so the watched
	// process dies on a path where the agents should be kept. Reaping there would also race
	// the new node's workers into the PID files, and a worker that adopts a PID this process
	// is about to kill joins a corpse and reports "already running" forever.
	const harper = startStub();
	const trace = startStub();
	const agents = { 'datadog-trace-agent': trace.pid };
	const root = makeRoot({ harperPid: harper.pid, agents });
	const reaper = startReaper(root, { harperPid: harper.pid, agents, graceMs: 10000 });

	harper.kill('SIGKILL');
	await waitUntil(() => !isAlive(harper.pid));

	// What `bin/run.js` does on startup: write the new main PID into hdb.pid.
	const replacement = startStub();
	fs.writeFileSync(path.join(root, 'hdb.pid'), String(replacement.pid));

	assert.ok(await waitUntil(() => !isAlive(reaper.pid)), 'the reaper did not stand down for the replacement');
	assert.ok(isAlive(trace.pid), 'the trace-agent was stopped even though a replacement node had taken over');
	assert.ok(
		fs.existsSync(path.join(root, 'pids', 'datadog-trace-agent.pid')),
		"the agent's PID file was removed, so the replacement node cannot adopt it"
	);
	assert.ok(
		!fs.existsSync(path.join(root, 'pids', 'datadog-agent-reaper.pid')),
		'the reaper left its own lock behind, so the replacement node can never start one'
	);

	replacement.kill('SIGKILL');
	trace.kill('SIGKILL');
	fs.rmSync(root, { recursive: true, force: true });
});

test('a stale hdb.pid does not pass for a replacement', async () => {
	// SIGKILL to Harper leaves hdb.pid behind, because the handler that removes it never
	// runs. Reading the file's existence as "a node is up" would make the hardest failure
	// the one case that never gets cleaned up.
	const harper = startStub();
	const trace = startStub();
	const agents = { 'datadog-trace-agent': trace.pid };
	const root = makeRoot({ harperPid: harper.pid, agents });
	startReaper(root, { harperPid: harper.pid, agents, graceMs: 3000 });

	harper.kill('SIGKILL');
	await waitUntil(() => !isAlive(harper.pid));
	// hdb.pid is deliberately left naming the dead process.
	assert.equal(fs.readFileSync(path.join(root, 'hdb.pid'), 'utf-8'), String(harper.pid));

	assert.ok(await waitUntil(() => !isAlive(trace.pid)), 'a stale hdb.pid stopped the reap');
	fs.rmSync(root, { recursive: true, force: true });
});

test('an agent that ignores SIGTERM is killed anyway', async () => {
	const harper = startStub();
	const stubborn = startStub(STUBBORN);
	const agents = { 'datadog-trace-agent': stubborn.pid };
	const root = makeRoot({ harperPid: harper.pid, agents });
	startReaper(root, { harperPid: harper.pid, agents });

	harper.kill('SIGKILL');
	// The SIGTERM grace is 5s, so this needs more than the default patience.
	assert.ok(
		await waitUntil(() => !isAlive(stubborn.pid), { timeoutMs: 25000 }),
		'a process that ignores SIGTERM kept 8126 bound after the node was gone'
	);

	const log = fs.readFileSync(path.join(root, 'logs', 'reaper.log'), 'utf-8');
	assert.match(log, /SIGKILL/, 'the escalation must be recorded; a silent SIGKILL is indistinguishable from a crash');
	fs.rmSync(root, { recursive: true, force: true });
});

test('a PID file naming a process that is already gone is not an error', async () => {
	const harper = startStub();
	const dead = startStub();
	const deadPid = dead.pid;
	dead.kill('SIGKILL');
	await waitUntil(() => !isAlive(deadPid));

	const agents = { 'datadog-trace-agent': deadPid };
	const root = makeRoot({ harperPid: harper.pid, agents });
	const reaper = startReaper(root, { harperPid: harper.pid, agents });

	harper.kill('SIGKILL');
	assert.ok(await waitUntil(() => !isAlive(reaper.pid)), 'the reaper hung on a PID file naming a dead process');
	assert.ok(
		!fs.existsSync(path.join(root, 'pids', 'datadog-trace-agent.pid')),
		'the stale PID file was not cleaned up'
	);
	fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A Harper that IS the container's init is pid 1, and pid 1 is a real process the reaper must
 * read as alive.
 *
 * isAlive() guards its input because kill(2) overloads non-positive pids into process-GROUP
 * selectors: 0 is the caller's own group and -n is group n, so a reaper that let either through
 * would signal itself and every sibling. The guard was `pid <= 1`, one value too wide, and it
 * made a live pid-1 Harper read as dead. In the stock Harper container under `harper run` that
 * fired on the reaper's first poll: "Harper pid 1 is gone" 4ms after start, then SIGTERM to both
 * agents once the restart grace elapsed. The agents handle SIGTERM and exit 0, so it surfaced as
 * "exited cleanly" and looked like an orderly shutdown rather than a kill.
 *
 * Asserted against pid 1 itself rather than a stand-in, because the defect was specifically that
 * the number 1 was excluded. Pid 1 exists on every platform this runs on; the reaper reaches it
 * either outright or via EPERM, and isAlive() already reads EPERM as alive.
 */
test('NEGATIVE: a Harper running as pid 1 is not read as dead and its agents survive', async () => {
	const trace = startStub();
	const core = startStub();
	const root = makeRoot({ harperPid: 1, agents: { 'datadog-trace-agent': trace.pid, 'datadog-agent': core.pid } });

	startReaper(root, { harperPid: 1, agents: { 'datadog-trace-agent': trace.pid, 'datadog-agent': core.pid } });

	// Comfortably past the poll interval and the zero grace, so a reaper that decided pid 1 was
	// gone would have finished killing by now.
	await sleep(3000);

	assert.ok(isAlive(trace.pid), 'the trace-agent was reaped while a pid-1 Harper was still running');
	assert.ok(isAlive(core.pid), 'the core agent was reaped while a pid-1 Harper was still running');

	const log = fs.readFileSync(path.join(root, 'logs', 'reaper.log'), 'utf8');
	assert.doesNotMatch(log, /is gone/, 'the reaper declared a live pid-1 Harper gone');
});
