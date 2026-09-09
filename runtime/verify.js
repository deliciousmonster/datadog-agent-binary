// What separates "the process is up" from "the process is the agent this node needs". A live process of the
// wrong kind, or a stray socket on the port, passes every cheaper check and is reported healthy.

import { describeExit } from "./agent-exit.js";
import { debugVarsUrl } from "./delivery.js";
import { parseJson, pollEndpoint } from "./probe.js";

/** The path dd-trace posts spans to. A receiver that does not advertise it is not one this node can use. */
const TRACE_ENDPOINT = "/v0.4/traces";

// Stated once so resources.js's probe blocklist can never name a different receiver URL than the one this
// file verifies against; a mismatch there is exactly the traffic the blocklist exists to keep out of APM.
export const receiverInfoUrl = (port) => `http://127.0.0.1:${port}/info`;

/** The core agent's expvar endpoint, built the same way for the same reason. */
export const expvarUrl = (port) => `http://127.0.0.1:${port}/debug/vars`;

// Both verifiers poll the same way and differ only in url; state.exited is the one giveUp condition either
// agent has, since a dead process cannot bind the port it is being polled for.
const pollAgent = (url, state) =>
	pollEndpoint({ url, giveUp: () => state.exited === true });

/** The pid this node's supervisor started, or null. A guard attempt that never reached a spawn leaves it undefined (the guard's src/supervise.js:156), and comparing against that reads a healthy agent as stale. */
const heldPid = (state) => (typeof state?.pid === "number" ? state.pid : null);

/** The pid an expvar body reports, or null when it publishes none. The trace-agent publishes it as a string, so a strict number test reads a real pid as no pid at all. */
function expvarPid(vars) {
	const pid = Number(vars?.pid);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Both agents get the same verdict for the same reason, so the operator reads one sentence either way. */
const foreignPid = (answering, held, url, title) =>
	`a ${title} answered ${url} as pid ${answering}, not the pid ${held} this node started, so the port ` +
	`belongs to a process nothing here supervises; stop it, or remove the stale .pid file under the node's ` +
	`pids/ directory, and restart`;

/** What the process did, when it did anything. A signalled exit reports no code, so `code || 0` reads it as a clean stop. */
function exitDetail(state) {
	if (state?.exited !== true) return "";
	if (typeof state.signal !== "string" && typeof state.code !== "number") {
		return " The process this node started is gone.";
	}
	const { detail } = describeExit(state.code ?? null, state.signal ?? null);
	return ` The process this node started ${detail}.`;
}

/** Prove the trace-agent serves the endpoint dd-trace posts to and is the process this node started; a bare TCP connect is satisfied by any stray socket, and dd-trace reports a successful flush either way. */
async function verifyTraceAgent(state, { paths, ports }) {
	if (ports.receiver === 0) {
		return {
			ok: false,
			detail:
				"apm_config.receiver_port is 0 (DD_APM_RECEIVER_PORT): the HTTP receiver is off, and " +
				"dd-trace drops every span unless it is pointed at a Unix socket instead",
		};
	}
	if (ports.debug === 0) {
		return {
			ok: false,
			detail:
				"apm_config.debug.port is 0 (DD_APM_DEBUG_PORT), so the trace-agent publishes no expvar and " +
				"nothing can tie whatever holds the receiver port to the process this node started",
		};
	}
	const url = receiverInfoUrl(ports.receiver);
	const body = await pollAgent(url, state);
	const endpoints = parseJson(body)?.endpoints;
	const serving =
		Array.isArray(endpoints) &&
		endpoints.some(
			(entry) => typeof entry === "string" && entry.includes(TRACE_ENDPOINT)
		);
	if (!serving) {
		return {
			ok: false,
			detail:
				body === null
					? `nothing answered ${url}, so dd-trace has nowhere to send spans.${exitDetail(state)} ` +
						`Check apm_config.enabled in ${paths.configFile} and DD_APM_ENABLED, then read ${paths.traceLog}`
					: `whatever answered ${url} does not advertise ${TRACE_ENDPOINT}, so it is not a trace-agent this node can rely on`,
		};
	}
	// /info identifies nobody: an agent left from an earlier boot answers it exactly like this node's own,
	// and it is the one holding the port this node's agent could not bind. The expvar names the pid.
	const identity = debugVarsUrl(ports.debug);
	const vars = parseJson(await pollAgent(identity, state));
	const answering = expvarPid(vars);
	if (answering === null) {
		return {
			ok: false,
			detail:
				`something serves ${TRACE_ENDPOINT} on 127.0.0.1:${ports.receiver}, but nothing answering ` +
				`${identity} named a pid, so it cannot be shown to be the trace-agent this node ` +
				`started.${exitDetail(state)} Read ${paths.traceLog}`,
		};
	}
	const held = heldPid(state);
	if (held !== null && answering !== held) {
		return {
			ok: false,
			detail: foreignPid(answering, held, identity, "trace-agent"),
		};
	}
	return {
		ok: true,
		detail: `the APM receiver serves ${TRACE_ENDPOINT} on 127.0.0.1:${ports.receiver} as pid ${answering}; dd-trace has somewhere to send spans`,
	};
}

/** Prove the process behind the lock is a core agent: only it publishes aggregator and forwarder, and a live process of the wrong kind passes every cheaper check. */
async function verifyCoreAgent(state, { paths, ports }) {
	if (ports.expvar === 0) {
		return {
			ok: false,
			detail:
				"expvar_port is 0 (DD_EXPVAR_PORT), so nothing can confirm the core agent is the process " +
				"holding its PID lock, and no host metric can be shown to be collected",
		};
	}
	const url = expvarUrl(ports.expvar);
	const vars = parseJson(await pollAgent(url, state));
	if (!vars || !("aggregator" in vars) || !("forwarder" in vars)) {
		return {
			ok: false,
			detail:
				`nothing answering ${url} identified itself as a core agent, so host metrics and tags are ` +
				`going nowhere while traces may still flow.${exitDetail(state)} A stale PID lock adopted by ` +
				`the wrong process produces exactly this; read ${paths.coreLog} and check ${paths.configFile}`,
		};
	}
	// Measured on 7.82.1: the core agent's expvar publishes no pid at all, so this engages only against a
	// build that grows one. What it cannot do is refuse a healthy agent for not publishing it.
	const held = heldPid(state);
	const answering = expvarPid(vars);
	if (answering !== null && held !== null && answering !== held) {
		return {
			ok: false,
			detail: foreignPid(answering, held, url, "core agent"),
		};
	}
	return {
		ok: true,
		detail:
			`the core agent serves expvar on 127.0.0.1:${ports.expvar}` +
			(held === null ? "" : ` as pid ${held}`),
	};
}

// A supervisor that never started it has nothing to verify: both verifiers would poll on, and read whatever
// else holds the port. Strictly false, because a caller that reports no `started` field does have a process.
const notStarted = (state) =>
	state?.started === false
		? {
				ok: false,
				detail:
					`this node never started it${state.error ? `: ${state.error}` : ""}, so nothing was ` +
					`polled and anything answering its port belongs to another process`,
			}
		: null;

/** The verdict for one launched agent. Both supervisors call this, so neither can reach a verdict the other cannot. */
export const verifyLaunch = (agent, state, context) => {
	// Each supervisor verifies once, after the first spawn, and then rewrites `pid` and `restarts` on this
	// same object without retaking the verdict. The pid it was taken against is the only record of that.
	state.verifiedPid = state.pid ?? null;
	return (
		notStarted(state) ??
		(agent.kind === "trace"
			? verifyTraceAgent(state, context)
			: verifyCoreAgent(state, context))
	);
};

/** True once the process the verdict describes has been replaced. A verdict taken against no pid at all cannot go stale, because it never named one. */
const stale = (state) =>
	typeof state?.verifiedPid === "number" && state.verifiedPid !== state.pid;

/**
 * Retake a stale verdict instead of reporting none. currentVerdict alone answers `verified: null` for the
 * life of the node once a process has been replaced, so a single chaos restart left the status saying
 * nothing had verified the running agent thirty minutes later, which is worse than the truth: this thread
 * can still poll the process it now supervises. The verdict stays per-thread, as the endpoint's contract
 * says; only its staleness is repaired. A verdict already taken against the running pid is returned
 * untouched, so a healthy read costs nothing.
 *
 * @param {Record<string, any>} state @param {(state: any) => Promise<{ok: boolean, detail: string}>} [verify]
 */
export async function retakeVerdict(state, verify) {
	if (!verify || !stale(state) || state?.started === false)
		return currentVerdict(state);
	// Written back onto the supervisor's own object, the way the guard writes the first verdict. A copy
	// looked right and was not: verifyLaunch stamps verifiedPid on the shared state before it polls, so
	// the next read saw a verdict that was no longer stale and served the previous detail beside the new
	// pid. Observed on 2026-09-09, one read in three naming the killed pid.
	try {
		const { ok, detail } = await verify(state);
		state.verified = ok;
		state.verifyDetail = detail;
	} catch (error) {
		state.verified = false;
		state.verifyDetail = `retaking the verdict against pid ${state.pid} threw: ${error instanceof Error ? error.message : String(error)}`;
	}
	return state;
}

/** The verdict as it stands now. Read at the endpoint rather than stamped at boot, because the supervisor keeps writing pid and restarts to the same object for the life of the node. */
export const currentVerdict = (state) =>
	stale(state)
		? {
				...state,
				verified: null,
				verifyDetail:
					`the last verdict was taken against pid ${state.verifiedPid}, which this node has since ` +
					`restarted ${state.restarts} time(s) as pid ${state.pid}. Nothing has verified the process ` +
					`now running; what the dead one proved was: ${state.verifyDetail}`,
			}
		: state;
