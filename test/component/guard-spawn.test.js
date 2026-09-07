// The guard half of supervision, split out because every case here needs the guard to spawn a real process
// from build/<platform>/bin - which is what scripts/windows-gate.mjs cannot run and excludes by this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
	APP_NAME,
	BOTH_AGENTS,
	CORE_AGENT,
	CORE_EXPVAR,
	REAPER,
	SERVING,
	TRACE_AGENT,
	withAgentsAnswering,
} from "../support/agents.js";
import {
	halt,
	lockedPid,
	lockFile,
	recordingScope,
	start,
	STAYS_UP,
	UNEXECUTABLE,
	waitForLocksCleared,
	withBuiltBinaries,
} from "../support/component.js";

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** The core agent's binary, overwritten with something no kernel will exec. preflight passes on it (it exists and is executable), so the guard gets as far as spawning and refusing it, which is the failure that still reaches a verify. */
function breakCoreBinary(files) {
	const core = files.find((file) => path.basename(file).startsWith(CORE_AGENT));
	fs.writeFileSync(core, UNEXECUTABLE);
	fs.chmodSync(core, 0o755);
}

/**
 * The guard path, with everything it spawned stopped before the runtime tree goes. Waiting for the locks to
 * clear is what keeps a release still in flight from writing into a deleted directory.
 */
async function withGuardStarted(
	run,
	{ stalePid, staleTracePid, breakCoreAgent } = {}
) {
	// Answered per request, not once: verification compares the pid on the lock against the pid the agent
	// reports, so a body fixed before the spawn can only ever describe a mismatch.
	let taken;
	const expvar = () => ({
		...CORE_EXPVAR,
		pid: stalePid ?? (taken ? lockedPid(taken, CORE_AGENT) : 0),
	});
	// The receiver port identifies nobody, so the trace-agent's verdict rests on this: the pid its own
	// expvar reports has to be the pid the guard locked.
	const debug = () => ({
		pid: String(staleTracePid ?? (taken ? lockedPid(taken, TRACE_AGENT) : 0)),
	});
	return withAgentsAnswering(
		{ info: SERVING, expvar, debug },
		async ({ root }) => {
			const pidDir = path.join(root, "datadog", APP_NAME, "pids");
			taken = pidDir;
			let status;
			let statusResource;
			try {
				// `run` goes inside, not after: withBuiltBinaries hands the real 139MB agents back the moment
				// its own callback resolves, so a guard restart in a test body would spawn one for real.
				return await withBuiltBinaries(async (files) => {
					if (breakCoreAgent) breakCoreBinary(files);
					// A Scope with no `processes` is what released Harper hands a plugin, and it used to be refused.
					({ status, DatadogStatus: statusResource } = await start({}));
					return run({ pidDir, status, statusResource });
				}, STAYS_UP);
			} finally {
				for (const state of status?.processes ?? []) halt(state.pid);
				halt(lockedPid(pidDir, REAPER));
				await waitForLocksCleared(pidDir, BOTH_AGENTS);
			}
		}
	);
}

test("where Harper has no processes.start, the bundled guard starts both agents and locks each one", async () => {
	await withGuardStarted(({ pidDir, status }) => {
		assert.equal(
			status.supervision,
			"guard",
			"a Harper without the sidecar API has to reach the bundled guard, not a refusal"
		);

		for (const name of BOTH_AGENTS) {
			const state = status.processes.find((entry) => entry.name === name);
			assert.equal(
				state.started,
				true,
				`the guard did not start ${name}: ${state.error}`
			);
			assert.ok(
				Number.isInteger(state.pid) && alive(state.pid),
				`${name} reports pid ${state.pid}, which is not a live process`
			);
			// The lock is the whole arbitration: without one every worker thread starts its own pair and all
			// but one fails to bind the receiver.
			assert.equal(
				lockedPid(pidDir, name),
				state.pid,
				`the guard started ${name} without recording it under ${pidDir}, so a second thread would start another`
			);
		}

		// Harper writes these behind its own sweep on the native path; on this one nothing else will, and
		// an agent started against a config file that is not there collects and forwards nothing.
		assert.ok(
			fs.existsSync(status.configFile),
			`the guard started both agents without writing ${status.configFile}`
		);
		assert.match(
			fs.readFileSync(status.configFile, "utf8"),
			new RegExp(`receiver_port:\\s*${status.receiverPort}\\b`),
			"the datadog.yaml the guard path wrote does not pin the receiver port the verifies read"
		);

		const reaper = lockedPid(pidDir, REAPER);
		assert.ok(
			reaper && alive(reaper),
			"no reaper is running, so both agents outlive the node that started them"
		);
		assert.equal(status.reaper.name, REAPER);
		// The guard's src/index.js sets `error` both when the reaper never started and when it started and only
		// its lock write failed, so without `started` this cannot be told from an absent reaper.
		assert.equal(
			status.reaper.started,
			true,
			`a reaper is running under ${pidDir} and the status cannot say so`
		);
		// The pid too: the status endpoint is the only thing a customer can read, and an operator told a
		// reaper is running still has to be able to find it without reading the lock directory by hand.
		assert.equal(
			status.reaper.pid,
			reaper,
			`the status reports reaper pid ${status.reaper.pid} against ${reaper} on the lock`
		);

		// The pid the guard really spawned is the one the verify was handed; a state assembled from the
		// declaration rather than from the spawn would name something else here.
		const core = status.processes.find((entry) => entry.name === CORE_AGENT);
		assert.equal(core.verified, true, core.verifyDetail);
	});
});

// The other side of the same check. A core agent answering with a pid this node does not hold the lock
// for is a stale lock adopted by the wrong process, and reporting it verified would hide exactly that.
test("NEGATIVE: a core agent answering as another pid does not verify", async () => {
	await withGuardStarted(
		({ status }) => {
			const core = status.processes.find((entry) => entry.name === CORE_AGENT);
			assert.equal(core.verified, false);
			assert.match(core.verifyDetail, /not the pid/);
		},
		{ stalePid: 4321 }
	);
});

// The receiver port identifies nobody: an agent left from an earlier boot answers /info exactly like this
// node's own, and it is the one holding the port this node's agent could not bind.
test("NEGATIVE: a trace-agent answering as another pid does not verify", async () => {
	await withGuardStarted(
		({ status }) => {
			const trace = status.processes.find((state) => state.kind === "trace");
			assert.equal(
				trace.verified,
				false,
				`whatever holds the receiver port was taken for this node's own agent: ${trace.verifyDetail}`
			);
			assert.match(trace.verifyDetail, /not the pid/);
		},
		{ staleTracePid: 4321 }
	);
});

test("NEGATIVE: an agent the guard could not start is not verified off whatever answers its port", async () => {
	// Four guard paths end with started:false and no pid (the guard's src/supervise.js:172-231), and
	// the guard's src/index.js:230 verifies those states anyway. Both stubs answer throughout this test, so a
	// poll that runs at all reports a stub as the agent this node started.
	await withGuardStarted(
		({ status }) => {
			const core = status.processes.find((state) => state.kind === "core");
			assert.equal(
				core.started,
				false,
				"the fixture was supposed to leave the core agent unstartable"
			);
			assert.equal(
				core.verified,
				false,
				`an agent this node never started was verified off the stub that answered its port: ${core.verifyDetail}`
			);
			assert.match(core.verifyDetail, /never started it/);
			// Same boot, same stubs: the agent that did start still has to verify, or the gate above is just
			// refusing everything.
			assert.equal(
				status.processes.find((state) => state.kind === "trace").verified,
				true,
				"the trace-agent started and answered both its endpoints, and was refused anyway"
			);
		},
		{ breakCoreAgent: true }
	);
});

/** Polls `read` every 100ms until it returns something other than null, or gives up after ~15s. */
async function until(read) {
	for (let attempt = 0; attempt < 150; attempt++) {
		const value = await read();
		if (value !== null) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
}

test("the status endpoint reports each agent as it is now, not as it was at boot", async () => {
	// The guard writes its ProcessState for the life of the node - a death, a restart, a give-up - so a copy
	// taken at boot goes on reporting healthy for an agent that is gone.
	await withGuardStarted(async ({ statusResource }) => {
		const traceOf = (status) =>
			status.processes.find((state) => state.kind === "trace");
		const boot = traceOf(await statusResource.get());
		assert.ok(
			alive(boot.pid),
			`the guard reported pid ${boot.pid} for the trace-agent, which is not running`
		);
		assert.equal(boot.exited, false);

		// SIGTERM: the guard reads a signalled stop as deliberate, so it releases the lock and starts nothing
		// in its place, which leaves the endpoint as the only thing that can still say the agent is gone.
		process.kill(boot.pid, "SIGTERM");
		const stopped = await until(async () => {
			const state = traceOf(await statusResource.get());
			return state.exited === true ? state : null;
		});

		assert.ok(
			stopped,
			`the endpoint still reports exited:false for pid ${boot.pid}, which the guard has already buried`
		);
		assert.equal(
			alive(stopped.pid),
			false,
			`the endpoint reports pid ${stopped.pid} as this node's trace-agent, and it is not running`
		);
	});
});

test("a verdict taken before a restart is not reported as the verdict on what is running now", async () => {
	// The other half of the same object. Each supervisor verifies once, after the first spawn, and its
	// restart path rewrites pid and restarts without retaking the verdict, so `verified: true` can end up
	// published beside a pid this node killed and replaced.
	// Not withGuardStarted: that hands the real binaries back before its callback runs, so the replacement
	// the guard starts here would be a real 139MB agent against ports these stubs already hold.
	let pidDir;
	const lockedTrace = () => (pidDir ? lockedPid(pidDir, TRACE_AGENT) : 0);
	await withAgentsAnswering(
		{
			info: SERVING,
			expvar: () => ({
				...CORE_EXPVAR,
				pid: pidDir ? lockedPid(pidDir, CORE_AGENT) : 0,
			}),
			debug: () => ({ pid: String(lockedTrace()) }),
		},
		async ({ root }) => {
			pidDir = path.join(root, "datadog", APP_NAME, "pids");
			let status;
			try {
				await withBuiltBinaries(async () => {
					let statusResource;
					({ status, DatadogStatus: statusResource } = await start({}));
					const traceOf = (reported) =>
						reported.processes.find((state) => state.kind === "trace");
					const boot = traceOf(await statusResource.get());
					assert.equal(boot.verified, true, boot.verifyDetail);
					// Read out, not held: the endpoint hands back the supervisor's live object, so `boot`
					// itself is what the restart rewrites.
					const bootPid = boot.pid;

					// SIGKILL, not SIGTERM: the guard reads SIGTERM as a deliberate stop and starts nothing in
					// its place, which is why the test above never exercises the fields that freeze.
					process.kill(bootPid, "SIGKILL");
					const restarted = await until(async () => {
						const state = traceOf(await statusResource.get());
						return state.restarts > 0 && state.pid !== bootPid ? state : null;
					});

					assert.ok(
						restarted,
						`the guard never restarted the trace-agent; it still reports pid ${bootPid}`
					);
					assert.notEqual(
						restarted.verified,
						true,
						`pid ${restarted.pid} is reported verified on a proof taken against pid ${bootPid}: ${restarted.verifyDetail}`
					);
					assert.match(
						restarted.verifyDetail,
						new RegExp(`taken against pid ${bootPid}`),
						`nothing tells the reader the verdict is stale: ${restarted.verifyDetail}`
					);
				}, STAYS_UP);
			} finally {
				for (const state of status?.processes ?? []) halt(state.pid);
				halt(lockedTrace());
				halt(lockedPid(pidDir, REAPER));
				await waitForLocksCleared(pidDir, BOTH_AGENTS);
			}
		}
	);
});

test("a deliberate stop releases the lock, so the next boot starts rather than adopting a corpse", async () => {
	const { pidDir, pids } = await withGuardStarted(({ pidDir, status }) => ({
		pidDir,
		pids: status.processes.map((entry) => entry.pid),
	}));

	// Stopped and waited for inside withGuardStarted, which is the behaviour under test: a lock kept across
	// a deliberate stop is one the next boot adopts, finding a pid that is gone or has been reused.
	for (const name of BOTH_AGENTS) {
		assert.equal(
			fs.existsSync(lockFile(pidDir, name)),
			false,
			`${name} kept its lock after a deliberate stop`
		);
	}
	for (const pid of pids) {
		assert.equal(alive(pid), false, `pid ${pid} survived the stop`);
	}
});
test("both supervisors report the same agents, started, under the same names", async () => {
	const identity = (status) =>
		status.processes.map(({ name, title, kind, started }) => ({
			name,
			title,
			kind,
			started,
		}));

	const guarded = await withGuardStarted(({ status }) => identity(status));
	const native = await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async () => {
			const { status } = await withBuiltBinaries(
				() => start(recordingScope()),
				STAYS_UP
			);
			return identity(status);
		}
	);

	// The fallback is only a fallback if what it reports can be read the same way: the status endpoint and
	// the delivery signal both index this list by name and kind.
	assert.deepEqual(
		guarded,
		native,
		"the two supervision paths report different agents for the same node"
	);
	assert.deepEqual(
		guarded.map((entry) => entry.started),
		[true, true],
		"a path that starts nothing would satisfy an equality check against another that starts nothing"
	);
});
/**
 * A guard lock naming a live process under a fingerprint this node cannot reproduce, which is what a
 * rotated DD_API_KEY leaves behind. `sleep` rather than a shell-script stub because the interpreter takes
 * over a shebang script's command line, and the command line is the whole identification.
 */
function plantOrphanLock(pidDir, name, pid) {
	fs.mkdirSync(pidDir, { recursive: true });
	const record = {
		token: "an-earlier-configuration",
		host: process.pid,
		argv: ["sleep", "300"],
	};
	fs.writeFileSync(
		lockFile(pidDir, name),
		`${pid}\n1\n${JSON.stringify(record)}\n`
	);
}

test("an agent still running under a configuration this node no longer has is stopped, not left holding the ports", async () => {
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async ({ root }) => {
			const pidDir = path.join(root, "datadog", APP_NAME, "pids");
			const orphan = spawn("sleep", ["300"], { stdio: "ignore" });
			plantOrphanLock(pidDir, CORE_AGENT, orphan.pid);

			let status;
			try {
				({ status } = await withBuiltBinaries(() => start({}), STAYS_UP));

				// The whole point of folding the credentials into the fingerprint: left running, the old agent
				// keeps posting under the old key and holds the ports its replacement needs, and once the lock
				// names the replacement instead, not even the reaper can find it again.
				// Polled, not read once: the guard sends SIGTERM and returns without waiting on it
				// (the guard's src/lock.js:247), so the death lands after start() has already resolved.
				assert.equal(
					await until(() => (alive(orphan.pid) ? null : "gone")),
					"gone",
					`pid ${orphan.pid} survived a start under a fingerprint it does not match`
				);

				const core = status.processes.find(
					(entry) => entry.name === CORE_AGENT
				);
				assert.notEqual(core.pid, orphan.pid);
				assert.equal(
					lockedPid(pidDir, CORE_AGENT),
					core.pid,
					"the replacement did not end up holding the lock the orphan left"
				);
				// The report names the signal and the pid it went to, not a death: the guard watches for
				// nothing, and an orphan that ignores SIGTERM is what the operator has to go looking for.
				assert.ok(
					status.supervisionReport?.some(
						(line) =>
							line.includes(`pid ${orphan.pid}`) && /sent SIGTERM/.test(line)
					),
					`the stop must reach an operator reading the status: ${JSON.stringify(status.supervisionReport)}`
				);
			} finally {
				halt(orphan.pid);
				for (const state of status?.processes ?? []) halt(state.pid);
				halt(lockedPid(pidDir, REAPER));
				await waitForLocksCleared(pidDir, BOTH_AGENTS);
			}
		}
	);
});
