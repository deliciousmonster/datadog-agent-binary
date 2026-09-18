// What GET /DatadogStatus/ publishes about processes it did not start, and about a reaper it did not run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { supervisorFor } from "../../runtime/component.js";
import { withTempDir } from "../support/sandbox.js";

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

const AGENT = {
	name: "datadog-agent",
	title: "core agent",
	kind: "core",
	command: "/bin/sh",
	args: [],
};

/** A spawn the guard's own attempt() cannot survive, which is how supervisor.js's catch is reached for real. */
const spawnThatBreaksGuard = () => ({
	on() {
		throw new TypeError(".on is not a function");
	},
});

test("NEGATIVE: an agent that never started answers the same questions a running one does", () =>
	withTempDir("status-shape-", async (pidDir) => {
		const supervisor = supervisorFor(
			{},
			{ log: SILENT, spawn: spawnThatBreaksGuard }
		);
		const { processes } = await supervisor.start([AGENT], {
			// Flat, because the guard supervises processes and knows nothing about a runtime tree. The
			// consumer reads its own paths out and hands over only what a supervisor needs.
			pidDir,
			reaperLog: join(pidDir, "reaper.log"),
			configFiles: {},
			fingerprintParts: ["status-shape-test"],
		});
		const [state] = processes;

		// `started` is the field that answers "is it running". A consumer reading `exited === false` for that
		// gets the same answer from an agent that never ran, which is why the other three cannot be absent.
		assert.equal(state.started, false);
		assert.equal(state.exited, false);
		assert.equal(state.adopted, false);
		assert.equal(state.restarts, 0);
	}));

// This assertion used to be its inverse: the reaper was copied through a ["adopted","name","started"] allowlist
// on the reasoning that a host this package does not ship may hang anything off it. The allowlist dropped
// `pid`, which is what an operator reads to find the process and what chaos testing kills, and `exited`, which
// on the native path is the death signal itself. With both gone the status endpoint re-derived liveness from a
// lock file this package never wrote, and published a live reaper as dead. The counterpoint the allowlist was
// built for is real and is kept below: a host that hangs an internal handle here does publish it.
test("Harper's own reaper reaches the status whole, as the object Harper goes on mutating", () =>
	withTempDir("status-shape-", async (root) => {
		const reaperState = {
			name: "harper-reaper",
			started: true,
			adopted: false,
			pid: 4242,
			exited: false,
			internalHandle: { socket: "/var/run/harper.sock" },
		};
		const scope = {
			processes: {
				reaper: reaperState,
				start: async (options) => {
					const state = { started: true, pid: process.pid, exited: false };
					const verdict = await options.verify(state);
					return { ...state, verified: verdict.ok };
				},
			},
		};

		const supervisor = supervisorFor(scope, { log: SILENT, spawn: () => {} });
		const { reaper } = await supervisor.start(
			[{ ...AGENT, verify: async () => ({ ok: true, detail: "" }) }],
			{
				pidDir: join(root, "pids"),
				configFiles: {},
				fingerprintParts: ["status-shape-test"],
			}
		);

		assert.equal(
			reaper.started,
			true,
			"a running reaper must be tellable from an absent one"
		);
		assert.equal(
			reaper.pid,
			4242,
			"the field an operator needs to find the process, and the one chaos testing kills"
		);
		assert.equal(
			reaper.exited,
			false,
			"and the one that carries its death on this path"
		);
		assert.equal(
			reaper,
			reaperState,
			"a copy freezes the status on what was true at boot; Harper mutates this object for the life of the node"
		);

		// The cost of publishing whole, asserted rather than left implicit: whatever the host hangs here is
		// published. A Harper SidecarState is plain data, and the fields the allowlist dropped are worth more.
		assert.deepEqual(reaper.internalHandle, { socket: "/var/run/harper.sock" });

		// Mutation is the point: the status endpoint reads this object again on every request
		reaperState.started = false;
		reaperState.error = "the reaper was terminated by SIGKILL";
		assert.equal(reaper.started, false);
		assert.equal(reaper.error, "the reaper was terminated by SIGKILL");
	}));
