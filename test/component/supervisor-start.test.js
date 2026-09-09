// Everything here is driven through handleApplication(scope), because that is the only path Harper takes and
// the only path that starts anything. A suite that called the internals directly would pass on a build where
// the plugin is never reached, which is the failure this component was shipped with.
//
// Nothing here spawns an agent: Harper's recorded sidecar stands in for the spawn. The cases that need the
// guard to spawn one for real live in guard-spawn.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	APP_NAME,
	BOTH_AGENTS,
	CORE_AGENT,
	CORE_EXPVAR,
	SERVING,
	TRACE_AGENT,
	withAgentsAnswering,
} from "../support/agents.js";
import {
	loadComponent,
	recordingScope,
	start,
	startFor,
	STAYS_UP,
	withBuiltBinaries,
} from "../support/component.js";
import { withEnvs, withTempDir } from "../support/sandbox.js";
import { captureLogs, findFreePort } from "../support/loopback.js";

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
			await withBuiltBinaries(() => start(scope));

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
			// The agent binds a UDS at the stock install path unless this is set, and fails at ERROR on every
			// start because that path is not there beside a component.
			assert.match(
				rendered,
				/^dogstatsd_socket: ""$/m,
				"the dogstatsd Unix socket is not disabled, so every agent start logs a failed bind"
			);
			// Same bind, the trace-agent's own: 57 `Could not start UDS listener` at ERROR over a day of
			// restarts on the 2026-09-09 run, because /var/run/datadog/ is the stock install's path.
			assert.match(
				rendered,
				/^\s+receiver_socket: ""$/m,
				"the APM Unix socket is not disabled, so every trace-agent start logs a failed bind"
			);
			// Unset, the logs agent tries `mkdir /opt/datadog-agent` and fails at ERROR on every start, and
			// its tail-offset registry has nowhere to live, so a restarted node re-tails every log from the top.
			assert.match(
				rendered,
				new RegExp(
					`^logs_config:\\n\\s+run_path: "${path.join(root, "datadog", APP_NAME, "run").replace(/[\\]/g, "\\\\\\\\")}"$`,
					"m"
				),
				"the logs agent must keep its registry under the runtime tree, not the stock install path"
			);
			// Live Processes is what reports Harper's and the agents' own CPU and memory; the Python process
			// check cannot run in this build, so this is the one way a node's processes reach Datadog.
			assert.match(
				rendered,
				/^process_config:\n  process_collection:\n    enabled: true$/m,
				"process collection is not enabled in the rendered config"
			);
			// Measured on 7.82.1: the environment outranks the file, so a written line can only ever restate
			// DD_DOGSTATSD_PORT or the agent's own default, and nothing here polls either port.
			assert.doesNotMatch(
				rendered,
				/^\s*(dogstatsd_port|cmd_port)\s*:/m,
				"a port line this component never probes cannot change what the agent binds"
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

test("NEGATIVE: an expvar body missing either core member is not a core agent", async () => {
	// The core side of the question the /v0.4/traces test asks on the trace side. Any live process answering
	// 200 with JSON passes every cheaper check, so the members only a core agent publishes are the whole gate.
	for (const missing of ["aggregator", "forwarder"]) {
		const expvar = { ...CORE_EXPVAR };
		delete expvar[missing];
		await withAgentsAnswering({ info: SERVING, expvar }, async () => {
			const { status } = await withBuiltBinaries(() => start(recordingScope()));
			const core = status.processes.find((state) => state.kind === "core");

			assert.equal(
				core.verified,
				false,
				`an expvar publishing no ${missing} was taken for a core agent: ${core.verifyDetail}`
			);
			assert.match(core.verifyDetail, /identified itself as a core agent/);
		});
	}
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

test("the warning for a missing DD_API_KEY reports what each agent actually does", async () => {
	// Measured against the shipped 7.82.1 binaries: the core agent starts and the intake refuses its payloads
	// with a 403, while the trace-agent exits 255 with "you must specify an API Key" and binds nothing. An
	// operator told both agents start looks for the receiver's spans rather than for the key.
	const receiver = await findFreePort();
	const expvarPort = await findFreePort();
	const lines = await withTempDir("dd-runtime-", (root) =>
		captureLogs(() =>
			withBuiltBinaries(() =>
				// exited, so the verifies give up on the first failed probe instead of waiting out a bind.
				start(recordingScope({ state: { exited: true } }), {
					ROOTPATH: root,
					DD_APM_RECEIVER_PORT: String(receiver),
					DD_EXPVAR_PORT: String(expvarPort),
					DD_API_KEY: undefined,
				})
			)
		)
	);

	const warning = lines.find((line) => line.includes("DD_API_KEY is not set"));
	assert.ok(
		warning,
		`no missing-key warning was logged at all; logged: ${JSON.stringify(lines)}`
	);
	assert.match(
		warning,
		/trace-agent does not start/,
		`the trace-agent exits 255 without a key; the warning has to say so: ${warning}`
	);
	assert.doesNotMatch(
		warning,
		/trace-agent will accept spans|[Bb]oth agents will start/,
		`the warning promises a receiver that never binds: ${warning}`
	);
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

test("NEGATIVE: a core agent whose state carries no pid is not reported stale against `undefined`", async () => {
	// Every guard attempt that fails before a spawn leaves state.pid undefined (the guard's src/supervise.js:155),
	// and the guard's src/index.js verifies those states anyway.
	await withAgentsAnswering(
		{ info: SERVING, expvar: CORE_EXPVAR },
		async () => {
			const scope = recordingScope({ state: { pid: undefined } });
			const { status } = await withBuiltBinaries(() => start(scope));
			const core = status.processes.find((state) => state.kind === "core");

			assert.equal(
				core.verified,
				true,
				`a core agent publishing aggregator and forwarder was refused: ${core.verifyDetail}`
			);
			assert.doesNotMatch(
				core.verifyDetail,
				/undefined/,
				`the verdict compared the answering pid against a pid nobody holds, and sends the operator to delete a live agent's lock: ${core.verifyDetail}`
			);
		}
	);
});
