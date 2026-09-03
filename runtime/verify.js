// What separates "the process is up" from "the process is the agent this node needs". A live process of the
// wrong kind, or a stray socket on the port, passes every cheaper check and is reported healthy.

import { threadId } from "node:worker_threads";

import { describeExit } from "./agent-exit.js";
import { parseJson, pollEndpoint } from "./probe.js";

/** The path dd-trace posts spans to. A receiver that does not advertise it is not one this node can use. */
const TRACE_ENDPOINT = "/v0.4/traces";

// Stated once so resources.js's probe blocklist can never name a different receiver URL than the one this
// file verifies against; a mismatch there is exactly the traffic the blocklist exists to keep out of APM.
export const receiverInfoUrl = (port) => `http://127.0.0.1:${port}/info`;

/** The core agent's expvar endpoint, built the same way for the same reason. */
export const expvarUrl = (port) => `http://127.0.0.1:${port}/debug/vars`;

// One line per thread per boot, and only where the endpoint made us wait. The failed probes are suppressed
// by design, so without this a bind that took seconds leaves nothing behind on the node at all.
const slowBindLogger =
	(title, url, logInfo) =>
	({ attempts, waitedMs }) =>
		logInfo(
			`Datadog supervisor: thread ${threadId} waited ${waitedMs}ms over ${attempts} probes for ${title} to answer ${url}.`
		);

/** What the process did, when it did anything. A signalled exit reports no code, so `code || 0` reads it as a clean stop. */
function exitDetail(state) {
	if (state?.exited !== true) return "";
	if (typeof state.signal !== "string" && typeof state.code !== "number") {
		return " The process this node started is gone.";
	}
	const { detail } = describeExit(state.code ?? null, state.signal ?? null);
	return ` The process this node started ${detail}.`;
}

/** Prove the trace-agent serves the endpoint dd-trace posts to; a bare TCP connect is satisfied by any stray socket, and dd-trace reports a successful flush either way. */
async function verifyTraceAgent(state, { paths, ports, logInfo }) {
	if (ports.receiver === 0) {
		return {
			ok: false,
			detail:
				"apm_config.receiver_port is 0 (DD_APM_RECEIVER_PORT): the HTTP receiver is off, and " +
				"dd-trace drops every span unless it is pointed at a Unix socket instead",
		};
	}
	const url = receiverInfoUrl(ports.receiver);
	const body = await pollEndpoint({
		url,
		giveUp: () => state.exited === true,
		onRetried: slowBindLogger("the APM receiver", url, logInfo),
	});
	const endpoints = parseJson(body)?.endpoints;
	const serving =
		Array.isArray(endpoints) &&
		endpoints.some(
			(entry) => typeof entry === "string" && entry.includes(TRACE_ENDPOINT)
		);
	if (serving) {
		return {
			ok: true,
			detail: `the APM receiver serves ${TRACE_ENDPOINT} on 127.0.0.1:${ports.receiver}; dd-trace has somewhere to send spans`,
		};
	}
	return {
		ok: false,
		detail:
			body === null
				? `nothing answered ${url}, so dd-trace has nowhere to send spans.${exitDetail(state)} ` +
					`Check apm_config.enabled in ${paths.configFile} and DD_APM_ENABLED, then read ${paths.traceLog}`
				: `whatever answered ${url} does not advertise ${TRACE_ENDPOINT}, so it is not a trace-agent this node can rely on`,
	};
}

/** Prove the process behind the lock is a core agent: only it publishes aggregator and forwarder, and a live process of the wrong kind passes every cheaper check. */
async function verifyCoreAgent(state, { paths, ports, logInfo }) {
	if (ports.expvar === 0) {
		return {
			ok: false,
			detail:
				"expvar_port is 0 (DD_EXPVAR_PORT), so nothing can confirm the core agent is the process " +
				"holding its PID lock, and no host metric can be shown to be collected",
		};
	}
	const url = expvarUrl(ports.expvar);
	const vars = parseJson(
		await pollEndpoint({
			url,
			giveUp: () => state.exited === true,
			onRetried: slowBindLogger("the core agent", url, logInfo),
		})
	);
	if (!vars || !("aggregator" in vars) || !("forwarder" in vars)) {
		return {
			ok: false,
			detail:
				`nothing answering ${url} identified itself as a core agent, so host metrics and tags are ` +
				`going nowhere while traces may still flow.${exitDetail(state)} A stale PID lock adopted by ` +
				`the wrong process produces exactly this; read ${paths.coreLog} and check ${paths.configFile}`,
		};
	}
	if (typeof vars.pid === "number" && vars.pid !== state.pid) {
		return {
			ok: false,
			detail: `a core agent answered ${url} as pid ${vars.pid}, not the pid ${state.pid} this node holds the lock for; remove the stale .pid file under the node's pids/ directory and restart`,
		};
	}
	return {
		ok: true,
		detail: `the core agent serves expvar on 127.0.0.1:${ports.expvar} as pid ${state.pid}`,
	};
}

/** The verdict for one launched agent. Both supervisors call this, so neither can reach a verdict the other cannot. */
export const verifyLaunch = (agent, state, context) =>
	agent.kind === "trace"
		? verifyTraceAgent(state, context)
		: verifyCoreAgent(state, context);
