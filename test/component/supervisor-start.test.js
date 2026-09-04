// Everything here is driven through handleApplication(scope), because that is the only path Harper takes and
// the only path that starts anything. A suite that called the internals directly would pass on a build where
// the plugin is never reached, which is the failure this component was shipped with.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	halt,
	loadComponent,
	lockedPid,
	lockFile,
	recordingScope,
	REPO_ROOT,
	start,
	startFor,
	STAYS_UP,
	waitForLocksCleared,
	withBuiltBinaries,
} from "../support/component.js";
import { withEnvs, withTempDir } from "../support/sandbox.js";
import {
	captureLogs,
	createStub,
	findFreePort,
	withServer,
} from "../support/loopback.js";

const TRACE_AGENT = "datadog-trace-agent";
const CORE_AGENT = "datadog-agent";
// prepareRuntime nests the runtime tree under the component's own directory name.
const APP_NAME = path.basename(REPO_ROOT);

/** A receiver answering /info, an expvar endpoint answering /debug/vars, and the component pointed at both. */
async function withAgentsAnswering({ info, expvar }, run) {
	return withServer(createStub({ answers: "/info", body: info }), (receiver) =>
		withServer(
			createStub({ answers: "/debug/vars", body: expvar }),
			(expvarPort) =>
				withTempDir("dd-runtime-", (root) =>
					withEnvs(
						{
							ROOTPATH: root,
							DD_APM_RECEIVER_PORT: String(receiver),
							DD_EXPVAR_PORT: String(expvarPort),
							DD_API_KEY: "test-key-not-a-real-one",
						},
						() => run({ root, receiver, expvarPort })
					)
				)
		)
	);
}

const SERVING = { endpoints: ["/v0.1/traces", "/v0.4/traces", "/v0.7/traces"] };
const CORE_EXPVAR = { aggregator: {}, forwarder: {}, pid: 4321 };

test("NEGATIVE: importing the module starts nothing; only handleApplication does", async () => {
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async () => {
			const scope = recordingScope();
			const { handleApplication, DatadogStatus } = await loadComponent();

			// A component Harper found by scanning componentsRoot gets exactly this far: the module is imported
			// for its resources and the plugin is never called.
			const before = await DatadogStatus.get();
			assert.deepEqual(scope.starts, [], "an import spawned an agent");
			assert.match(
				before.detail,
				/harper-config\.yaml/,
				"the unstarted status must name the root-config entry, which is the only thing that fixes it"
			);

			const built = await withBuiltBinaries(async (files) => {
				handleApplication(scope);
				await DatadogStatus.get();
				return files;
			});
			assert.deepEqual(
				scope.starts.map((options) => options.name).sort(),
				[CORE_AGENT, TRACE_AGENT],
				"handleApplication must start both agents, under the two names Harper locks on"
			);
			// The fixture writes what src/binaries.ts says the build produces, so a name this module invents
			// for itself resolves nothing and the receiver never comes up.
			assert.deepEqual(
				scope.starts.map((options) => path.basename(options.command)).sort(),
				built.map((file) => path.basename(file)).sort(),
				"the binaries this module asks for are not the ones the build ships"
			);
			// A second call joins the first rather than starting again; every worker thread makes one.
			handleApplication(scope);
			await DatadogStatus.get();
			assert.equal(
				scope.starts.length,
				2,
				"a second call started a second pair"
			);
		}
	);
});

test("NEGATIVE: a deploy validation load starts nothing", async () => {
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async () => {
			const scope = recordingScope();
			scope.isTransientValidation = true;
			await withBuiltBinaries(() => start(scope));
			assert.deepEqual(
				scope.starts,
				[],
				"every `harper deploy` would re-enter the spawn path against the live node"
			);
		}
	);
});

test("the rendered datadog.yaml keeps the credentials off disk and pins what the verifies read", async () => {
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async ({ root, receiver, expvarPort }) => {
			const scope = recordingScope();
			const dogstatsdPort = await findFreePort();
			const cmdPort = await findFreePort();
			await withBuiltBinaries(() =>
				start(scope, {
					DD_DOGSTATSD_PORT: String(dogstatsdPort),
					DD_CMD_PORT: String(cmdPort),
				})
			);

			const traceStart = startFor(scope, TRACE_AGENT);
			const configFile = path.join(root, "datadog", APP_NAME, "datadog.yaml");
			const rendered = traceStart.configFiles[configFile];
			assert.ok(rendered, `no datadog.yaml was written for ${configFile}`);

			assert.doesNotMatch(
				rendered,
				/^\s*(api_key|site)\s*:/m,
				"the key and the site ride in DD_API_KEY / DD_SITE and must never be written to disk"
			);
			assert.match(
				rendered,
				new RegExp(`receiver_port: ${receiver}\\b`),
				"the receiver port in the config must be the one the verify polls"
			);
			assert.match(
				rendered,
				new RegExp(`expvar_port: ${expvarPort}\\b`),
				"the expvar port in the config must be the one the core-agent verify polls"
			);
			assert.match(
				rendered,
				new RegExp(`dogstatsd_port: ${dogstatsdPort}\\b`),
				"dogstatsd_port must be pinned to the port this instance resolved"
			);
			assert.match(
				rendered,
				new RegExp(`cmd_port: ${cmdPort}\\b`),
				"cmd_port must be pinned to the port this instance resolved"
			);
			assert.doesNotMatch(
				rendered,
				/dogstatsd_port: 8125\b/,
				"dogstatsd_port fell back to Datadog's own hardcoded default rather than the pinned one"
			);
			assert.doesNotMatch(
				rendered,
				/cmd_port: 5001\b/,
				"cmd_port fell back to Datadog's own hardcoded default rather than the pinned one"
			);
			assert.match(
				rendered,
				/log_file_max_size: "5Mb"[\s\S]*log_file_max_rolls: 2/,
				"an unbounded agent log fills the volume Harper's own data is on"
			);
			assert.match(rendered, /apm_non_local_traffic: false/);
			assert.match(rendered, /bind_host: "127\.0\.0\.1"/);

			// On both starts, not one: Harper writes the files as part of start(), so naming them on a single
			// agent lets the other spawn before its config exists.
			assert.deepEqual(
				startFor(scope, CORE_AGENT).configFiles,
				traceStart.configFiles,
				"both agents must carry the same config set or one spawns without it"
			);
		}
	);
});

test("NEGATIVE: without the core-check configs the agent collects no host metric, so they ship and are written", async () => {
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async ({ root }) => {
			const scope = recordingScope();
			const { status } = await withBuiltBinaries(() => start(scope));
			const confd = path.join(root, "datadog", APP_NAME, "conf.d");
			const written = Object.keys(
				startFor(scope, CORE_AGENT).configFiles
			).filter((file) => file.startsWith(confd));

			assert.ok(
				status.coreChecks.includes("cpu") &&
					status.coreChecks.includes("memory"),
				`no host-metric check was collected: ${JSON.stringify(status.coreChecks)}`
			);
			for (const check of status.coreChecks) {
				assert.ok(
					written.includes(path.join(confd, `${check}.d`, "conf.yaml.default")),
					`${check} was reported as collected and no conf.yaml.default was written for it`
				);
			}
			// The gate exists because these two checks do not build everywhere, and a config for a check the
			// catalog has no entry for surfaces as a Loading Error rather than as metrics.
			const gated = { load: ["linux", "darwin"], network: ["linux", "win32"] };
			for (const [check, platforms] of Object.entries(gated)) {
				assert.equal(
					status.coreChecks.includes(check),
					platforms.includes(process.platform),
					`${check} is ${status.coreChecks.includes(check) ? "" : "not "}configured on ${process.platform}`
				);
			}
		}
	);
});

test("a conf.yaml.default this start does not own is removed, and an operator's own conf.yaml is not", async () => {
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async ({ root }) => {
			const confd = path.join(root, "datadog", APP_NAME, "conf.d");
			const stale = path.join(confd, "retired_check.d");
			const operator = path.join(confd, "operator_check.d");
			fs.mkdirSync(stale, { recursive: true });
			fs.mkdirSync(operator, { recursive: true });
			fs.writeFileSync(path.join(stale, "conf.yaml.default"), "instances:\n");
			fs.writeFileSync(path.join(operator, "conf.yaml"), "instances:\n");

			await withBuiltBinaries(() => start(recordingScope()));

			assert.equal(
				fs.existsSync(path.join(stale, "conf.yaml.default")),
				false,
				"a default left by an older version keeps configuring a check nothing ships any more"
			);
			assert.equal(
				fs.existsSync(path.join(operator, "conf.yaml")),
				true,
				"an operator's own check config was deleted"
			);
		}
	);
});

test("NEGATIVE: a receiver that does not advertise /v0.4/traces does not count as bound", async () => {
	// A bare TCP connect is satisfied by any stray socket on the port, and dd-trace reports a successful
	// flush into one either way, so the launch has to ask the process what it serves.
	await withAgentsAnswering(
		{ info: { endpoints: ["/v0.7/traces"] }, expvar: CORE_EXPVAR },
		async () => {
			const scope = recordingScope();
			const { status } = await withBuiltBinaries(() => start(scope));
			const trace = status.processes.find((state) => state.kind === "trace");

			assert.equal(
				trace.verified,
				false,
				"something answered /info without the endpoint dd-trace posts to and was taken for a trace-agent"
			);
			assert.match(trace.verifyDetail, /\/v0\.4\/traces/);
		}
	);

	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async () => {
			const scope = recordingScope();
			const { status } = await withBuiltBinaries(() => start(scope));
			assert.equal(
				status.processes.find((state) => state.kind === "trace").verified,
				true,
				"a receiver advertising /v0.4/traces is the case this must still accept"
			);
		}
	);
});

test("NEGATIVE: receiver_port 0 refuses loudly instead of falling back to 8126", async () => {
	const free = await findFreePort();
	await withTempDir("dd-runtime-", async (root) => {
		const scope = recordingScope({ state: { exited: true } });
		const { status } = await withBuiltBinaries(() =>
			start(scope, {
				ROOTPATH: root,
				DD_APM_RECEIVER_PORT: "0",
				DD_EXPVAR_PORT: String(free),
				DD_API_KEY: "test-key-not-a-real-one",
			})
		);
		const trace = status.processes.find((state) => state.kind === "trace");

		assert.equal(status.receiverPort, 0, "0 was reinterpreted as the default");
		assert.equal(trace.verified, false);
		assert.match(
			trace.verifyDetail,
			/receiver_port is 0/,
			"the HTTP receiver is off and dd-trace drops every span; the verdict has to say so"
		);
	});
});

test("NEGATIVE: an unparseable port warns and falls back rather than being read as a prefix", async () => {
	// parseInt takes the digits it can and stops, so "8126tcp" resolves to 8126 and both agents are pointed
	// at a port nobody wrote. The verify then passes against whatever happens to hold it.
	for (const raw of ["8126tcp", "eight-thousand", "70000", "-1"]) {
		const captured = [];
		await withTempDir("dd-runtime-", (root) =>
			captureLogs(async () => {
				const component = await withEnvs(
					{ ROOTPATH: root, DD_APM_RECEIVER_PORT: raw },
					() => loadComponent()
				);
				captured.push(await component.DatadogStatus.get());
			})
		).then((lines) => captured.push(lines));

		const [status, warnings] = captured;
		assert.equal(
			status.receiverPort,
			8126,
			`DD_APM_RECEIVER_PORT="${raw}" resolved to ${status.receiverPort} instead of falling back`
		);
		assert.ok(
			warnings.some((line) => line.includes(raw)),
			`the rejected value must appear in the warning; logged: ${JSON.stringify(warnings)}`
		);
	}
});

test("NEGATIVE: an agent the kernel killed is reported as killed, not as a stop", async () => {
	const receiver = await findFreePort();
	const expvarPort = await findFreePort();
	await withTempDir("dd-runtime-", async (root) => {
		// Nothing is listening, and Harper reports the child gone with no exit code, which is what an OOM
		// kill looks like from the supervisor's side.
		const scope = recordingScope({
			state: { exited: true, code: null, signal: "SIGKILL" },
		});
		const { status } = await withBuiltBinaries(() =>
			start(scope, {
				ROOTPATH: root,
				DD_APM_RECEIVER_PORT: String(receiver),
				DD_EXPVAR_PORT: String(expvarPort),
				DD_API_KEY: "test-key-not-a-real-one",
			})
		);

		for (const state of status.processes) {
			assert.match(
				state.verifyDetail,
				/SIGKILL/,
				`the ${state.title} verdict does not say the process was killed: ${state.verifyDetail}`
			);
			assert.doesNotMatch(state.verifyDetail, /exited cleanly/);
		}
	});
});

// Who supervises, driven from both sides. The guard half spawns for real and reads the locks off disk,
// because a fallback exercised through a stub is a fallback nobody has run.

const REAPER = "datadog-agent-reaper";
const BOTH_AGENTS = [TRACE_AGENT, CORE_AGENT];

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * The guard path, with everything it spawned stopped before the runtime tree goes. Waiting for the locks to
 * clear is what keeps a release still in flight from writing into a deleted directory.
 */
async function withGuardStarted(run, { stalePid } = {}) {
	// Answered per request, not once: verification compares the pid on the lock against the pid the agent
	// reports, so a body fixed before the spawn can only ever describe a mismatch.
	let taken;
	const expvar = () => ({
		...CORE_EXPVAR,
		pid: stalePid ?? (taken ? lockedPid(taken, CORE_AGENT) : 0),
	});
	return withAgentsAnswering({ info: SERVING, expvar }, async ({ root }) => {
		const pidDir = path.join(root, "datadog", APP_NAME, "pids");
		taken = pidDir;
		let status;
		try {
			// A Scope with no `processes` is what released Harper hands a plugin, and it used to be refused.
			({ status } = await withBuiltBinaries(() => start({}), STAYS_UP));
			return await run({ pidDir, status });
		} finally {
			for (const state of status?.processes ?? []) halt(state.pid);
			halt(lockedPid(pidDir, REAPER));
			await waitForLocksCleared(pidDir, BOTH_AGENTS);
		}
	});
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

test("NEGATIVE: where Harper has processes.start, the guard never runs, and says so", async () => {
	const captured = [];
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async ({ root }) => {
			const scope = recordingScope();
			const logged = await captureLogs(async () => {
				captured.push(await withBuiltBinaries(() => start(scope), STAYS_UP));
			});
			const { status } = captured[0];

			assert.equal(status.supervision, "harper");
			assert.deepEqual(
				scope.starts.map((options) => options.name).sort(),
				[...BOTH_AGENTS].sort(),
				"Harper's own sidecar was not given both agents"
			);
			// The guard writes a lock before it spawns, so an empty pid directory is what separates "the
			// native path ran" from "both of them did", which no assertion on the native path can tell apart.
			assert.deepEqual(
				fs.readdirSync(path.join(root, "datadog", APP_NAME, "pids")),
				[],
				"the guard took a lock under a Harper that supervises natively, so two supervisors hold one pair of agents"
			);

			// (a) the boot log names the guard as present-but-unused, in words an operator reads directly.
			assert.ok(
				logged.some((line) => /guard/i.test(line) && /unused/i.test(line)),
				`the boot log never said the guard went unused; logged: ${JSON.stringify(logged)}`
			);
			// (b) the same fact lands on the status object, so a caller can assert on it without grepping a log.
			assert.ok(
				status.supervisionReport?.some(
					(line) => /guard/i.test(line) && /unused/i.test(line)
				),
				`status.supervisionReport must carry the same fact the boot log does; got: ${JSON.stringify(status.supervisionReport)}`
			);
		}
	);
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
