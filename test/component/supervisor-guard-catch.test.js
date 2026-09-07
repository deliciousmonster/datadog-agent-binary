// guardSupervisor's catch, exercised for real: no config in this repo makes guard() reject, so the only
// way to reach the branch is to hand it a spawn shaped so the guard's own attempt() throws past every try/catch
// it already has. A mock of the catch itself would prove nothing about what real callers can trigger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { supervisorFor } from "../../runtime/supervisor.js";
import { withTempDir } from "../support/sandbox.js";

// A Scope with no `processes.start` is what selects guardSupervisor; see supervisorFor's own check.
const NO_NATIVE_SUPERVISION = {};

/**
 * A spawn that "succeeds" (throws nothing, passes preflight already happened) but returns a value that
 * is not an EventEmitter. The guard's attempt() calls child.on('error', ...) immediately after a
 * successful spawn with no try/catch around it, so this is what a spawn shaped unlike node's real
 * child_process.spawn actually does to guard() - reject the whole call, not just the one agent whose
 * binary was involved. The thrown TypeError carries an ENOENT code, the same shape a real fs failure
 * would, so a test against the fix can tell "translated per agent's own binary" from "raw and shared":
 * describeSpawnFailure only engages its per-code template when `error.code` matches one of its keys.
 */
const spawnThatThrowsACodedError = () => ({
	on() {
		const error = new TypeError(".on is not a function");
		error.code = "ENOENT";
		throw error;
	},
});

test("NEGATIVE: a guard() rejection reports both agents with the same untranslated message, not a per-binary spawn diagnosis", () =>
	withTempDir("guard-catch-", async (pidDir) => {
		const logged = { errors: [] };
		const log = {
			info: () => {},
			warn: () => {},
			error: (message) => logged.errors.push(message),
		};

		// Different commands and different preflight-passing binaries: this is what makes describeSpawnFailure's
		// per-agent translation (pre-fix) produce two DIFFERENT messages rather than coincidentally the same one.
		const agents = [
			{
				name: "agent-one",
				title: "Agent One",
				kind: "trace",
				command: process.execPath,
				args: [],
			},
			{
				name: "agent-two",
				title: "Agent Two",
				kind: "core",
				command: "/bin/sh",
				args: [],
			},
		];

		const supervisor = supervisorFor(NO_NATIVE_SUPERVISION, {
			log,
			spawn: spawnThatThrowsACodedError,
		});
		assert.equal(
			supervisor.kind,
			"guard",
			"a Scope with no processes.start must select the bundled guard"
		);

		const result = await supervisor.start(agents, {
			runtime: { paths: { pidDir, reaperLog: join(pidDir, "reaper.log") } },
			configFiles: {},
			fingerprintParts: ["supervisor-guard-catch-test"],
		});

		assert.equal(
			result.processes.length,
			2,
			"the catch must still report one entry per declared agent"
		);
		for (const [index, state] of result.processes.entries()) {
			assert.equal(state.started, false);
			assert.equal(state.name, agents[index].name);
			assert.equal(state.kind, agents[index].kind);
			assert.ok(state.error, `${state.name} carries no error at all`);
		}

		// The core of the fix: one shared cause, reported once, not reinterpreted per agent.
		assert.equal(
			result.processes[0].error,
			result.processes[1].error,
			"both agents must carry the identical raw message; guard() rejected once for both, not per binary"
		);
		assert.equal(
			result.report.length,
			1,
			"one guard() rejection must produce one report line, not one per agent"
		);

		// describeSpawnFailure's ENOENT template embeds the binary path ("${path} does not exist (ENOENT)...");
		// since the two agents' commands differ, that template would print two DIFFERENT strings here. The
		// fix reports the error's own raw message instead, which names neither binary.
		assert.doesNotMatch(
			result.processes[0].error,
			/does not exist \(ENOENT\)|platform package resolved/,
			`the message was run through describeSpawnFailure's per-binary ENOENT template: ${result.processes[0].error}`
		);
		assert.match(
			result.processes[0].error,
			/\.on is not a function/,
			`expected the untranslated TypeError from the guard's attempt(); got: ${result.processes[0].error}`
		);

		// guard() starts the agents in order and rejects out of the one it was on, so an agent ahead of it in
		// the list is already running under a committed lock. Reporting both unstarted and saying nothing
		// else leaves an operator with no reason to look for it.
		assert.match(
			result.processes[0].error,
			/running unsupervised/,
			`the report claims neither agent started without saying one of them may be running: ${result.processes[0].error}`
		);
		assert.ok(
			result.processes[0].error.includes(pidDir),
			`an operator told an agent is unsupervised needs the directory its lock is in: ${result.processes[0].error}`
		);

		assert.ok(
			logged.errors.some((line) =>
				line.includes("the guard call for both agents threw")
			),
			`the boot log must still say the call threw; logged: ${JSON.stringify(logged.errors)}`
		);
	}));
