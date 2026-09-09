// A verdict taken against a pid the node has since replaced reported `verified: null` for the life of
// the node. One chaos restart on the 2026-09-09 run left the status saying nothing had verified the
// running trace-agent half an hour later, while the thread reading it could have polled the process it
// was supervising. currentVerdict marks the staleness; retakeVerdict repairs it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { currentVerdict, retakeVerdict } from "../../runtime/verify.js";

const started = (over = {}) => ({
	name: "datadog-trace-agent",
	started: true,
	pid: 2534,
	verifiedPid: 879,
	restarts: 1,
	verified: true,
	verifyDetail: "the APM receiver serves /v0.4/traces as pid 879",
	...over,
});

describe("retaking a stale verdict", () => {
	it("marks the verdict stale without a verifier, as before", async () => {
		const state = started();
		const now = await retakeVerdict(state, undefined);
		assert.equal(now.verified, null);
		assert.deepEqual(now, currentVerdict(state));
	});

	it("retakes it against the running pid when a verifier is given", async () => {
		let asked;
		const verify = async (state) => {
			asked = state.pid;
			return { ok: true, detail: `the receiver serves as pid ${state.pid}` };
		};
		const now = await retakeVerdict(started(), verify);
		assert.equal(
			asked,
			2534,
			"the verifier is asked about the pid now running"
		);
		assert.equal(now.verified, true);
		assert.match(now.verifyDetail, /2534/);
	});

	it("reports a failed retake as unverified rather than as no verdict", async () => {
		const verify = async () => ({
			ok: false,
			detail: "nothing answered the receiver port",
		});
		const now = await retakeVerdict(started(), verify);
		assert.equal(now.verified, false);
		assert.equal(now.verifyDetail, "nothing answered the receiver port");
	});

	it("NEGATIVE: does not poll a verdict that is not stale", async () => {
		let called = 0;
		const verify = async () => {
			called++;
			return { ok: true, detail: "polled" };
		};
		const fresh = started({ verifiedPid: 2534 });
		const now = await retakeVerdict(fresh, verify);
		assert.equal(called, 0, "a healthy read must cost no probe");
		assert.equal(now, fresh);
	});

	it("NEGATIVE: does not poll for a process this node never started", async () => {
		let called = 0;
		const verify = async () => {
			called++;
			return { ok: true, detail: "polled" };
		};
		// verifyLaunch stamps verifiedPid from state.pid, so a process that never started carries null.
		const refused = started({
			started: false,
			pid: undefined,
			verifiedPid: null,
			verified: false,
			verifyDetail: "this node never started it",
		});
		const now = await retakeVerdict(refused, verify);
		assert.equal(
			called,
			0,
			"nothing to poll, and the port may belong to another process"
		);
		assert.equal(now.verified, false);
	});

	it("survives a verifier that throws, and says which pid it was asking about", async () => {
		const verify = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const now = await retakeVerdict(started(), verify);
		assert.equal(now.verified, false);
		assert.match(now.verifyDetail, /pid 2534/);
		assert.match(now.verifyDetail, /ECONNREFUSED/);
	});
});
