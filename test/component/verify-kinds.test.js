// Each agent kind is verified by the check that proves it is that agent, and an unknown kind is refused.
//
// The failure being guarded is a fallback. Routing an unrecognised kind to the core agent's verifier gives
// it a verdict about expvar it never serves, which reads to an operator as a broken agent rather than as a
// verifier nobody wrote. Two of the four kinds here are new, so the fallback would have been the cheap way
// to add them and would have made both of them permanently unhealthy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyLaunch } from "../../runtime/component.js";

const PATHS = {
	coreLog: "/logs/agent.log",
	traceLog: "/logs/trace-agent.log",
	sysprobeLog: "/logs/system-probe.log",
	securityLog: "/logs/security-agent.log",
	configFile: "/datadog.yaml",
	// Absent, so the connect fails at once and `exited` ends the poll on the first pass.
	sysprobeSocket: join(tmpdir(), "ddab-absent-sysprobe.sock"),
	securitySocket: join(tmpdir(), "ddab-absent-runtime-security.sock"),
};

// Ports nothing serves. `exited: true` is what stops each poll after its first failure, so these tests
// cost one refused connection each rather than a 30-second deadline.
const CONTEXT = {
	paths: PATHS,
	ports: { receiver: 1, expvar: 2, debug: 3, dogstatsd: 4 },
};

const dead = { started: true, exited: true, pid: 4242, restarts: 0 };

const verdictFor = (kind) =>
	verifyLaunch({ kind, title: kind }, { ...dead }, CONTEXT);

test("each kind is verified against the thing that proves it is that agent", async () => {
	const detail = Object.fromEntries(
		await Promise.all(
			["trace", "core", "process", "sysprobe", "security"].map(async (kind) => [
				kind,
				(await verdictFor(kind)).detail,
			])
		)
	);
	// The receiver's /info, which is what advertises the path dd-trace posts to.
	assert.match(detail.trace, /127\.0\.0\.1:1\/info/);
	// expvar, which only the core agent publishes with aggregator and forwarder in it.
	assert.match(detail.core, /debug\/vars/);
	// Sockets, not ports: these two serve unix sockets and a port check would pass on any listener.
	assert.match(detail.sysprobe, /sysprobe\.sock/);
	assert.match(detail.security, /runtime-security\.sock/);
});

test("NEGATIVE: no kind borrows another kind's evidence", async () => {
	const detail = Object.fromEntries(
		await Promise.all(
			["trace", "core", "process", "sysprobe", "security"].map(async (kind) => [
				kind,
				(await verdictFor(kind)).detail,
			])
		)
	);
	// The specific confusion the dispatch exists to prevent: a socket-serving agent judged on expvar.
	for (const kind of ["sysprobe", "security"])
		assert.doesNotMatch(
			detail[kind],
			/expvar|debug\/vars/,
			`${kind} was verified against the core agent's endpoint`
		);
	assert.doesNotMatch(detail.core, /sysprobe\.sock/);
	assert.doesNotMatch(detail.trace, /sysprobe\.sock/);
});

// A kind nobody wrote a verifier for has to say that, rather than inheriting a verdict about an endpoint it
// never serves. Adding a fifth agent should fail loudly here, not report the new agent as broken.
test("NEGATIVE: an unknown kind is refused rather than routed to a verifier that does not fit", async () => {
	const verdict = await verifyLaunch(
		{ kind: "cluster", title: "cluster-agent" },
		{ ...dead },
		CONTEXT
	);
	assert.equal(verdict.ok, false);
	assert.match(verdict.detail, /knows how to verify/);
	assert.match(verdict.detail, /cluster/);
	assert.doesNotMatch(
		verdict.detail,
		/expvar|debug\/vars/,
		"an unverifiable agent was judged on the core agent's endpoint"
	);
});

// notStarted outranks every kind: a supervisor that never spawned it has nothing to poll, and polling
// anyway reads whatever else holds the socket.
test("NEGATIVE: an agent this node never started is not polled at all", async () => {
	for (const kind of ["sysprobe", "security"]) {
		const verdict = await verifyLaunch(
			{ kind, title: kind },
			{ started: false, error: "the probe package is not installed" },
			CONTEXT
		);
		assert.equal(verdict.ok, false);
		assert.match(verdict.detail, /never started it/);
		assert.match(verdict.detail, /probe package is not installed/);
	}
});
