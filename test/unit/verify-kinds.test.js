// Each agent kind is verified by the check that proves it is that agent, and an unknown kind is refused. The
// failure being guarded is a fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyLaunch } from "../../runtime/verify.js";

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

// The other half of the 2026-09-15 fix. The guard decides a verdict of `false` may be asked again; only this
// file knows what asking costs. The boot poll waits 30 s because the process it asks about was spawned a moment
// ago and has bound nothing yet, and a read-path retake is holding a /DatadogStatus/ request open while it
// waits. Handing the retake that same 30 s is how the fix would have traded a stuck `false` for a stuck reader.
// A live state, not the `exited: true` the tests above use: the point here is the deadline, so the poll has to
// reach one.
const live = () => ({ started: true, exited: false, pid: 4242, restarts: 0 });

const securityVerdictIn = async (state, context) => {
	const began = performance.now();
	const verdict = await verifyLaunch(
		{ kind: "security", title: "security-agent" },
		state,
		CONTEXT,
		context
	);
	return { verdict, took: performance.now() - began };
};

test("a retake of a refused verdict is not given the boot poll's budget", async () => {
	const { verdict, took } = await securityVerdictIn(live(), {
		reason: "refuted",
	});
	assert.equal(
		verdict.ok,
		false,
		"nothing serves the socket, so the verdict still says no"
	);
	assert.ok(
		took < 2_000,
		`a retake ran ${Math.round(took)}ms with a status request held open; it gets its own short budget`
	);
});

// And the short budget must not leak the other way: a security-agent whose socket appears a few seconds after
// its process starts is the normal case, and 750 ms of waiting at boot would refuse every one of them. Bounded
// by flipping `exited` rather than by waiting out the real deadline, so the suite does not pay 30 s to read it.
test("NEGATIVE: the boot poll keeps the long budget a just-spawned process needs", async () => {
	const state = live();
	setTimeout(() => {
		state.exited = true;
	}, 2_500).unref();
	const { verdict, took } = await securityVerdictIn(state, undefined);
	assert.equal(verdict.ok, false);
	assert.ok(
		took >= 2_400,
		`the boot poll gave up after ${Math.round(took)}ms, which is the retake budget leaking into it`
	);
});
