// Harper's constrained spawn hands back a pid it never identified. Three times across 2026-09-08 and 09
// it handed the core agent's spawn the trace-agent's pid, and the guard refused it, so that thread ended
// with `started: false` while the node's core agent was up and healthy under another thread. The endpoint
// answers "is this agent running" for the node, so the refusal is a diagnostic rather than the health.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { nodeProcess } from "../../runtime/supervisor.js";
import { retakeVerdict } from "../../runtime/verify.js";

const NAME = "datadog-agent";
const DEAD_PID = 2 ** 22 - 7;
const REFUSAL =
	"this node never started it: the spawn of the core agent handed back pid 878, which is running the trace-agent";

const refusedState = () => ({
	name: NAME,
	kind: "core",
	started: false,
	adopted: false,
	exited: false,
	restarts: 0,
	verified: false,
	verifiedPid: null,
	error: REFUSAL,
});

describe("what the node has, for a thread that has nothing", () => {
	let dir;
	let child;
	let childArgv;

	const lock = (pid, argv) =>
		writeFileSync(
			join(dir, `${NAME}.pid`),
			`${pid}\n7\n${JSON.stringify({ token: "t", host: 1, argv })}`
		);

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "dd-node-process-"));
		childArgv = [process.execPath, "-e", "setInterval(function () {}, 1000)"];
		child = spawn(childArgv[0], childArgv.slice(1), { stdio: "ignore" });
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	after(() => {
		child?.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports the process the lock identifies, and keeps the thread's refusal", () => {
		lock(child.pid, childArgv);
		const now = nodeProcess(refusedState(), dir);
		assert.equal(
			now.started,
			true,
			"the node has this agent, whatever this thread was handed"
		);
		assert.equal(now.pid, child.pid);
		assert.equal(now.adopted, true);
		assert.equal(now.refused, REFUSAL, "the refusal is kept, not lost");
		assert.equal(
			now.error,
			undefined,
			"and it stops being reported as the agent's error"
		);
		assert.equal(
			now.verified,
			undefined,
			"no verdict has been taken against this pid by this thread"
		);
	});

	it("leaves a verdict to be retaken against the node's pid rather than publishing none", async () => {
		lock(child.pid, childArgv);
		const verify = async (state) => ({
			ok: true,
			detail: `the core agent serves expvar as pid ${state.pid}`,
		});
		const now = await retakeVerdict(nodeProcess(refusedState(), dir), verify);
		assert.equal(now.verified, true);
		assert.match(now.verifyDetail, new RegExp(String(child.pid)));
	});

	it("NEGATIVE: keeps the refusal when the lock names a pid nothing holds", () => {
		lock(DEAD_PID, childArgv);
		const now = nodeProcess(refusedState(), dir);
		assert.equal(
			now.started,
			false,
			"nothing is running, so nothing is reported running"
		);
		assert.equal(now.error, REFUSAL);
	});

	it("NEGATIVE: keeps the refusal when the lock names a live pid running something else", () => {
		lock(child.pid, ["/nonexistent/datadog-agent", "run"]);
		const now = nodeProcess(refusedState(), dir);
		assert.equal(
			now.started,
			false,
			"an unidentified pid is not this node's agent"
		);
		assert.equal(now.error, REFUSAL);
	});

	it("NEGATIVE: leaves a thread that started its own process exactly as it is", () => {
		lock(child.pid, childArgv);
		const own = {
			...refusedState(),
			started: true,
			pid: 4242,
			verified: true,
			error: undefined,
		};
		assert.equal(nodeProcess(own, dir), own);
	});

	it("NEGATIVE: does nothing without a pid directory", () => {
		const state = refusedState();
		assert.equal(nodeProcess(state, undefined), state);
	});
});
