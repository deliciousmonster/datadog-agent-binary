"use strict";

/**
 * The launcher's supervision internals: `receiverPort()`, `isRunSubcommand()`,
 * `isTraceReceiverHealthy()`, and `onExit()`. Each guards a failure mode that
 * surfaces only as silently dropped spans; they are reached through the
 * launcher's `internalsForTesting` export.
 *
 * Hermetic: the only sockets are ephemeral 127.0.0.1 listeners standing in for
 * a receiver, the same device test/e2e/harper-component.test.js uses.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LAUNCHER_PATH = path.join(REPO_ROOT, "dist", "agent-launcher.js");

const { receiverPort, isRunSubcommand, isTraceReceiverHealthy, onExit } =
	require(LAUNCHER_PATH).internalsForTesting;

async function withReceiverPortEnv(value, run) {
	const previous = process.env.DD_APM_RECEIVER_PORT;
	if (value === undefined) delete process.env.DD_APM_RECEIVER_PORT;
	else process.env.DD_APM_RECEIVER_PORT = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.DD_APM_RECEIVER_PORT;
		else process.env.DD_APM_RECEIVER_PORT = previous;
	}
}

function listen(server) {
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(server.address().port))
	);
}

function closeServer(server) {
	return new Promise((resolve) => server.close(resolve));
}

/** A 127.0.0.1 port with nothing listening on it. */
function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/**
 * An HTTP stub answering only /info with `body`, or with a raw non-JSON
 * payload. Any other path 404s: the probe URL is part of the contract under
 * test, and a stub that answers everything lets a probe-path typo pass.
 */
function fakeReceiver({ status = 200, body, raw, path = "/info" } = {}) {
	return http.createServer((request, response) => {
		if (request.url !== path) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end("{}");
			return;
		}
		response.writeHead(status, { "content-type": "application/json" });
		response.end(raw ?? JSON.stringify(body ?? {}));
	});
}

/**
 * Run `onExit` with `process.exit` replaced by a throw, and return the exit
 * code. The throw matters: a real exit never returns, and a stub that returns
 * would let the code fall through into branches that cannot execute in
 * production.
 */
async function exitCodeFrom(run) {
	class ExitCall extends Error {
		constructor(code) {
			super(`process.exit(${code})`);
			this.code = code ?? 0;
		}
	}
	const realExit = process.exit;
	process.exit = (code) => {
		throw new ExitCall(code);
	};
	try {
		await run();
		throw new Error("onExit returned without calling process.exit");
	} catch (error) {
		if (error instanceof ExitCall) return error.code;
		throw error;
	} finally {
		process.exit = realExit;
	}
}

test("receiverPort() defaults to 8126, the port dd-trace dials", async () => {
	await withReceiverPortEnv(undefined, () => {
		assert.equal(receiverPort(), 8126);
	});
});

test("receiverPort() honours DD_APM_RECEIVER_PORT", async () => {
	await withReceiverPortEnv("9126", () => {
		assert.equal(receiverPort(), 9126);
	});
});

test("receiverPort() falls back on an unusable override instead of binding it", async () => {
	// listen(NaN) and listen(0) both "succeed", on a port no tracer will dial.
	for (const bad of ["banana", "0", "-1"]) {
		await withReceiverPortEnv(bad, () => {
			assert.equal(receiverPort(), 8126, `override "${bad}"`);
		});
	}
});

test("isRunSubcommand() treats a bare invocation and `run` as the receiver", () => {
	assert.equal(isRunSubcommand([]), true);
	assert.equal(isRunSubcommand(["run"]), true);
});

test("short-lived queries are not mistaken for the receiver", () => {
	// `version` while a receiver is up must not be swallowed by the
	// already-running check; misclassifying it exits 0 without running anything.
	assert.equal(isRunSubcommand(["version"]), false);
	assert.equal(isRunSubcommand(["status"]), false);
});

test("isTraceReceiverHealthy() is false when nothing listens", async () => {
	assert.equal(await isTraceReceiverHealthy(await findFreePort()), false);
});

test("a /info listing a /traces endpoint is the only healthy answer", async () => {
	const server = fakeReceiver({
		body: { endpoints: ["/v0.4/traces", "/v0.7/config"] },
	});
	const port = await listen(server);
	try {
		assert.equal(await isTraceReceiverHealthy(port), true);
	} finally {
		await closeServer(server);
	}
});

test("the probe asks /info specifically, not just any answering path", async () => {
	// A receiver serving the right body somewhere else must read as unhealthy,
	// or a probe-URL typo in the launcher would ship green against this suite.
	const server = fakeReceiver({
		body: { endpoints: ["/v0.4/traces"] },
		path: "/some-other-info",
	});
	const port = await listen(server);
	try {
		assert.equal(await isTraceReceiverHealthy(port), false);
	} finally {
		await closeServer(server);
	}
});

test("an HTTP listener without a /traces endpoint is not a receiver", async () => {
	// Any leftover health-check stub accepts connections and answers 200;
	// treating it as "APM is handled" is the failure this probe exists to stop.
	for (const body of [
		{ endpoints: ["/health"] },
		{ endpoints: [] },
		{},
		{ endpoints: "not-an-array" },
	]) {
		const server = fakeReceiver({ body });
		const port = await listen(server);
		try {
			assert.equal(
				await isTraceReceiverHealthy(port),
				false,
				`body ${JSON.stringify(body)} passed for a trace-agent`
			);
		} finally {
			await closeServer(server);
		}
	}
});

test("a non-2xx or non-JSON /info answer is unhealthy, not an error", async () => {
	for (const options of [
		{ status: 503, body: { endpoints: ["/v0.4/traces"] } },
		{ raw: "<html>It works!</html>" },
	]) {
		const server = fakeReceiver(options);
		const port = await listen(server);
		try {
			assert.equal(await isTraceReceiverHealthy(port), false);
		} finally {
			await closeServer(server);
		}
	}
});

test("a listener that accepts and never answers times out to unhealthy", async () => {
	// A bare TCP socket is exactly what a stray port-forward looks like. The
	// accepted sockets are destroyed by hand: the aborted probe can leave its
	// server side open, and net.Server.close() waits on it forever.
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const port = await listen(server);
	try {
		assert.equal(await isTraceReceiverHealthy(port, 250), false);
	} finally {
		for (const socket of sockets) socket.destroy();
		await closeServer(server);
	}
});

test("onExit() treats a signal as a clean stop", async () => {
	assert.equal(
		await exitCodeFrom(() => onExit("core", "datadog-agent", null, "SIGTERM")),
		0
	);
});

test("onExit() passes a clean exit through", async () => {
	assert.equal(
		await exitCodeFrom(() => onExit("core", "datadog-agent", 0, null)),
		0
	);
});

test("a failing core agent exits non-zero; no receiver probe applies", async () => {
	assert.equal(
		await exitCodeFrom(() => onExit("core", "datadog-agent", 1, null)),
		1
	);
});

test("trace rc=1 with a healthy receiver on the port is already-running", async () => {
	const server = fakeReceiver({ body: { endpoints: ["/v0.4/traces"] } });
	const port = await listen(server);
	try {
		await withReceiverPortEnv(String(port), async () => {
			assert.equal(
				await exitCodeFrom(() =>
					onExit("trace", "datadog-trace-agent", 1, null)
				),
				0,
				"EADDRINUSE against a live receiver means APM is served; rc must be 0"
			);
		});
	} finally {
		await closeServer(server);
	}
});

test("trace rc=1 with nothing on the port stays a failure", async () => {
	const port = await findFreePort();
	await withReceiverPortEnv(String(port), async () => {
		assert.equal(
			await exitCodeFrom(() => onExit("trace", "datadog-trace-agent", 1, null)),
			1,
			"a startup failure with no receiver present must not be reported as success"
		);
	});
});

test("trace rc=1 next to an unrelated listener stays a failure", async () => {
	// The regression guarded here: a bare port check cannot tell EADDRINUSE
	// against a real receiver from a misconfigured agent dying beside a stray
	// socket, and the latter must stay loud.
	const server = fakeReceiver({ body: { endpoints: ["/health"] } });
	const port = await listen(server);
	try {
		await withReceiverPortEnv(String(port), async () => {
			assert.equal(
				await exitCodeFrom(() =>
					onExit("trace", "datadog-trace-agent", 1, null)
				),
				1
			);
		});
	} finally {
		await closeServer(server);
	}
});
