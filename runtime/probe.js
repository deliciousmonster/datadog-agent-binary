// Every request this module makes is invisible to APM: the plugin polls the agents before they bind, when
// polls fail, and on the line this replaces those failures became errored client spans on the customer's own service.

import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";

const PROBE_TIMEOUT_MS = 1000;
const MAX_INTERVAL_MS = 5_000;

// The store dd-trace keeps its OWN agent traffic out of the customer's APM with, applied to these probes for
// the same reason. Private path, so a miss falls back to untraceAgentProbes, which is the public half of this.
const untraced = (() => {
	try {
		const core = createRequire(import.meta.url)(
			"dd-trace/packages/datadog-core"
		);
		const legacy = core.storage("legacy");
		return (run) => legacy.run({ noop: true }, run);
	} catch {
		return (run) => run();
	}
})();

// A process-global setting, so the next `tracer.use('http', ...)` from anywhere replaces it: dd-trace's
// configurePlugin overwrites a plugin's config rather than merging into it. Kept only as a fallback for releases where the private store above has moved; it cannot stand alone.
export function untraceAgentProbes(tracer, blocklist) {
	tracer.use("http", { client: { blocklist } }); // under `client`, or the server half drops inbound traces too
}

/** A probe body as JSON, or null. Never throws: these bodies come off a socket and pollEndpoint's own contract is the same. */
export function parseJson(body) {
	try {
		return body === null ? null : JSON.parse(body);
	} catch {
		return null;
	}
}

/** GET over http or https, accepting the trace-agent's self-signed IPC certificate. Loopback only: never point this off 127.0.0.1. Global fetch cannot stand in for it, because Node exposes no public dispatcher for that certificate. */
function get(url, timeoutMs) {
	return new Promise((resolve) => {
		let deadline;
		const settle = (body) => {
			clearTimeout(deadline);
			resolve(body);
		};
		// node:http ignores rejectUnauthorized, so the scheme is the only difference between the two probes.
		const send = url.startsWith("https:") ? httpsRequest : httpRequest;
		const call = send(url, { rejectUnauthorized: false }, (response) => {
			const status = response.statusCode;
			if (status === undefined || status < 200 || status >= 300) {
				response.resume();
				settle(null);
				return;
			}
			let body = "";
			response.setEncoding("utf-8");
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => settle(body));
			// The reset a destroy() lands on an open response arrives here, not on the request, and an
			// unheard one leaves this promise pending for the life of the process.
			response.on("error", () => settle(null));
		});
		call.on("error", () => settle(null));
		// One deadline over the whole exchange rather than the socket's own inactivity timeout: a response
		// that starts and then stalls, or drips a byte at a time, never trips that one.
		deadline = setTimeout(() => {
			call.destroy();
			settle(null);
		}, timeoutMs);
		call.end();
	});
}

// Run under `untraced`: the span is created where the request is made, so that is the only place suppression
// cannot be undone by other code in the process.
async function probe(url, timeoutMs) {
	try {
		// Awaited inside the try rather than returned: `untraced` reaches into a dd-trace private path, and
		// pollEndpoint's never-throws contract has to hold if that path moves.
		return await untraced(() => get(url, timeoutMs));
	} catch {
		return null;
	}
}

/**
 * Whether anything accepts a connection on a unix socket path. Never throws, same contract as `probe`.
 *
 * A connect and an immediate close, with no request written: system-probe speaks HTTP over this socket, but
 * what is being asked is whether it is listening, and a bare accept answers that without needing to know a
 * route that could move between agent versions. An ECONNREFUSED, an ENOENT, or a path that is not a socket
 * all arrive here as false.
 */
function probeSocket(path, timeoutMs) {
	return new Promise((resolve) => {
		let deadline;
		const settle = (answered) => {
			clearTimeout(deadline);
			socket.destroy();
			resolve(answered);
		};
		const socket = connect(path);
		socket.on("connect", () => settle(true));
		socket.on("error", () => settle(false));
		deadline = setTimeout(() => settle(false), timeoutMs);
	});
}

/** {@link pollEndpoint} against a unix socket, for the two agents that serve one instead of a loopback port. */
export async function pollUnixSocket({
	path,
	timeoutMs = 30_000,
	intervalMs = 250,
	giveUp,
}) {
	const deadline = Date.now() + timeoutMs;
	let interval = intervalMs;
	for (;;) {
		const budget = Math.min(
			PROBE_TIMEOUT_MS,
			Math.max(deadline - Date.now(), 1)
		);
		// Untraced for the same reason the HTTP probes are: a failed connect during startup would otherwise
		// become an errored client span on the customer's own service.
		const answered = await untraced(() => probeSocket(path, budget)).catch(
			() => false
		);
		if (answered) return true;
		if (giveUp?.() || Date.now() >= deadline) return false;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(interval, deadline - Date.now()))
		);
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}

/**
 * GET until something answers: the body text, or null on deadline or giveUp(). Never throws. `intervalMs`
 * doubles every retry up to MAX_INTERVAL_MS: a flat 250ms wait costs ~120 probes over a ~6-7s expvar bind.
 */
export async function pollEndpoint({
	url,
	timeoutMs = 30_000,
	intervalMs = 250,
	giveUp,
}) {
	const deadline = Date.now() + timeoutMs;
	let interval = intervalMs;
	for (;;) {
		const budget = Math.min(
			PROBE_TIMEOUT_MS,
			Math.max(deadline - Date.now(), 1)
		);
		const body = await probe(url, budget);
		if (body !== null) return body;
		// Asked between probes, and only after one has failed, so a target that answered then died still counts.
		if (giveUp?.() || Date.now() >= deadline) return null;
		// Clamped to what is left: backing off must not spend the caller's budget asleep past the deadline.
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(interval, deadline - Date.now()))
		);
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}

/**
 * Keep this component's own polling out of the host application's APM.
 *
 * dd-trace is resolved rather than imported: it belongs to the host application and this package does not
 * ship it. A process with no tracer has nothing to keep the probes out of, which is the silent path. A
 * tracer that answers `use()` with a shape untraceAgentProbes did not expect is different: the probes stay
 * traced and start appearing as spans, so that one gets a line.
 *
 * @param {readonly string[]} urls Every endpoint this component polls.
 * @param {import('./log.js').Log} log
 * @param {(id: string) => unknown} [require] Injected for tests; defaults to this module's own resolver.
 */
export function suppressAgentProbes(urls, log, require = undefined) {
	const load = require ?? createRequire(import.meta.url);
	let tracer;
	try {
		tracer = load("dd-trace");
	} catch {
		return { traced: false, reason: "dd-trace is not resolvable from here" };
	}
	try {
		untraceAgentProbes(tracer, urls);
		return { traced: true };
	} catch (error) {
		log.error(
			`Datadog supervisor: found dd-trace but could not configure it to ignore the agent probes: ${error.stack ?? error.message}. Probe requests may now appear as spans in APM.`
		);
		return { traced: false, reason: error.message };
	}
}
