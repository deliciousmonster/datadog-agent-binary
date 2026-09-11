// Proving each process does its job: what separates "the process is up" from "the process is the agent
// this node needs". A live process of the wrong kind, or a stray socket on the port, passes every cheaper
// check and is reported healthy.
//
// Called from two places, which is why it is its own file. The start path verifies once after each spawn,
// and scripts that drive a real binary on a CI runner reach for the same verdicts rather than writing a
// second, weaker idea of what a working agent looks like.

import {
	describeExit,
	neverStarted,
	parseJson,
	pollEndpoint,
	pollUnixSocket,
	takeVerdictAgainst,
} from "@deliciousmonster/harper-process-guard";

import { debugVarsUrl, expvarUrl, receiverInfoUrl } from "./datadog.js";

/** The path dd-trace posts spans to. A receiver that does not advertise it is not one this node can use. */
const TRACE_ENDPOINT = "/v0.4/traces";

// Both verifiers poll the same way and differ only in url; state.exited is the one giveUp condition either
// agent has, since a dead process cannot bind the port it is being polled for.
const pollAgent = (url, state) =>
	pollEndpoint({ url, giveUp: () => state.exited === true });

/** The same wait, against a unix socket: system-probe and security-agent serve sockets, not loopback ports. */
const pollSocket = (path, state) =>
	pollUnixSocket({ path, giveUp: () => state.exited === true });

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

/**
 * Prove system-probe is serving its socket, which is the only thing that makes it useful to anything else.
 *
 * A unix socket, not a port, so this is a connect rather than an HTTP poll of a loopback address. The core
 * agent and security-agent both reach it the same way, so a socket nothing accepts on is precisely the state
 * where system-probe is running and no consumer can tell.
 */
async function verifySystemProbe(state, { paths }) {
	const socket = paths.sysprobeSocket;
	const served = await pollSocket(socket, state);
	if (!served) {
		return {
			ok: false,
			detail:
				`nothing is accepting connections on ${socket}, so the core agent's service discovery and ` +
				`security-agent's runtime security have nothing to talk to.${exitDetail(state)} eBPF needs ` +
				`root or CAP_SYS_ADMIN and an object matching the running kernel; read ${paths.sysprobeLog}`,
		};
	}
	const held = heldPid(state);
	return {
		ok: true,
		detail:
			`system-probe accepts connections on ${socket}` +
			(held === null ? "" : ` as pid ${held}`),
	};
}

/** The same for security-agent, whose runtime security serves its own socket beside system-probe's. */
async function verifySecurityAgent(state, { paths }) {
	const socket = paths.securitySocket;
	const served = await pollSocket(socket, state);
	if (!served) {
		return {
			ok: false,
			detail:
				`nothing is accepting connections on ${socket}, so no runtime-security event can reach the ` +
				`backend.${exitDetail(state)} It talks to system-probe over its own socket and exits when ` +
				`system-probe is not running; read ${paths.securityLog}`,
		};
	}
	const held = heldPid(state);
	return {
		ok: true,
		detail:
			`security-agent accepts connections on ${socket}` +
			(held === null ? "" : ` as pid ${held}`),
	};
}

/**
 * Prove process-agent is doing the one thing it was shipped for: shipping what system-probe collects.
 *
 * Not "is it up". The core agent already runs the `process` and `rtprocess` checks, so a process-agent
 * that starts and ships nothing extra is indistinguishable from not having it, and that is precisely the
 * state this package was in before: `network_tracer` loaded, `Connections Queue length: 0`. The evidence
 * is its expvar, which carries the enabled check list.
 */
async function verifyProcessAgent(state, { paths, ports }) {
	const url = expvarUrl(ports.processExpvar);
	const vars = parseJson(await pollAgent(url, state));
	if (!vars) {
		return {
			ok: false,
			detail:
				`nothing answering ${url} identified itself as a process-agent, so nothing is shipping the ` +
				`connections system-probe collects.${exitDetail(state)} Read ${paths.processLog}`,
		};
	}
	// The whole reason it is here. `connections` absent means eBPF programs collecting into nothing.
	// Nested under `process_agent`, not at the top level: read from the root it comes back empty on a
	// process-agent that is shipping perfectly well, which is a verifier that fails an agent for the
	// thing it is doing.
	const checks = JSON.stringify(vars.process_agent?.enabled_checks ?? "");
	if (!checks.includes("connections")) {
		return {
			ok: false,
			detail:
				`process-agent is up and its enabled checks are ${checks}, which does not include ` +
				`connections. system-probe's network data has no shipper, which is the state shipping this ` +
				`binary was meant to end. Check network_config.enabled in ${paths.sysprobeConfigFile}`,
		};
	}
	const held = heldPid(state);
	return {
		ok: true,
		detail:
			`process-agent runs the connections check${held === null ? "" : ` as pid ${held}`}, so what ` +
			`system-probe collects has somewhere to go`,
	};
}

/** The verdict for one launched agent. Both supervisors call this, so neither can reach a verdict the other cannot. */
export const verifyLaunch = (agent, state, context) => {
	// Each supervisor verifies once, after the first spawn, and then rewrites `pid` and `restarts` on this
	// same object without retaking the verdict. The pid it was taken against is the only record of that.
	takeVerdictAgainst(state);
	const byKind = {
		trace: verifyTraceAgent,
		core: verifyCoreAgent,
		process: verifyProcessAgent,
		sysprobe: verifySystemProbe,
		security: verifySecurityAgent,
	};
	// Defaulting to the core agent's verifier would hand a new kind a verdict about expvar it never serves,
	// which reads as a broken agent rather than as a missing verifier.
	const verify = byKind[agent.kind];
	if (!verify)
		return {
			ok: false,
			detail: `nothing here knows how to verify an agent of kind "${agent.kind}"`,
		};
	return neverStarted(state) ?? verify(state, context);
};
