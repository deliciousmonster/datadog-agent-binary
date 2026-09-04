// What GET /DatadogStatus/ publishes about processes it did not start, and about a reaper it did not run.
// Both supervisors feed one array and one object, so a consumer indexing either has to get the same answers
// out of whichever path produced the entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { supervisorFor } from "../../runtime/supervisor.js";
import { withTempDir } from "../support/sandbox.js";

const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

const AGENT = {
	name: "datadog-agent",
	title: "core agent",
	kind: "core",
	command: "/bin/sh",
	args: [],
};

/** A spawn guard/src's own attempt() cannot survive, which is how supervisor.js's catch is reached for real. */
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
			runtime: { paths: { pidDir, reaperLog: join(pidDir, "reaper.log") } },
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

test("Harper's own reaper is shaped before it reaches the status, not copied into it", () =>
	withTempDir("status-shape-", async (root) => {
		// A field a real Harper may hang off its reaper, which nothing in this package has read or documented.
		const scope = {
			processes: {
				reaper: {
					name: "harper-reaper",
					started: true,
					adopted: false,
					internalHandle: { socket: "/var/run/harper.sock" },
				},
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
				runtime: { paths: { pidDir: join(root, "pids") } },
				configFiles: {},
				fingerprintParts: ["status-shape-test"],
			}
		);

		assert.equal(
			reaper.started,
			true,
			"a running reaper must be tellable from an absent one"
		);
		assert.deepEqual(
			Object.keys(reaper).sort(),
			["adopted", "name", "started"],
			"the status endpoint published Harper's own object rather than the fields this package documents"
		);
	}));
