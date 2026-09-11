// The Harper component: what it starts, what it watches, and what it says about itself.
//
// Everything Datadog declares is in runtime/datadog.js and arrives here as an import. What is here is the
// other direction: start the processes that file describes, prove each one is doing its job, read back whether
// anything reached Datadog, measure what the processes cost, and answer one REST resource with all of it.
//
// One file, because it is one lifecycle. The seams that used to be module boundaries are section rules below,
// and they run in the order a node does: state, suppression, proof, delivery, measurement, supervision,
// reporting, and the wiring that connects them.
//
// `spawn` and Harper's compartment globals arrive as arguments to datadog() at the bottom, because resources.js
// is the only file Harper compiles and so the only place they can be read. A module that imports `spawn`
// itself gets the unconstrained one, which is the whole reason the constrained one exists.

import { createRequire } from "node:module";
import { join } from "node:path";
import { basename, dirname } from "node:path";
import { threadId } from "node:worker_threads";

import {
	claimSingleton,
	claimStaleMs,
	createHandleApplication,
	currentReaper,
	describeExit,
	neverStarted,
	nodeProcess,
	normaliseLog,
	parseJson,
	pollEndpoint,
	pollUnixSocket,
	readProcess,
	retakeVerdict,
	selfProcess,
	sharedMarks,
	supervisorFor as guardSupervisorFor,
	tailFile,
	takeVerdictAgainst,
	unstarted,
	untraceWith,
	watchForNeverCalled,
} from "@deliciousmonster/harper-process-guard";

import {
	LABEL,
	PACKAGE_NAME,
	REAPER_NAME,
	agentsFor,
	debugVarsUrl,
	expvarUrl,
	prepareRuntime as prepare,
	probeStatus,
	receiverInfoUrl,
	resolveBinary,
	resolveEbpfDir,
	resolvePorts,
	writeConfigFiles,
} from "./datadog.js";

// runtime/ sits directly under the component root, and the root is what Harper installs and what
// prepareRuntime renders against. Derived rather than passed, so resources.js has one less thing in it.
const COMPONENT_DIR = dirname(import.meta.dirname);

// -- This thread's own state ------------------------------------------------------------------------------
//
// Per instance, never per module. resources.js is re-evaluated with a cache-busting query string in tests,
// and state at module scope would leak the first evaluation's pids and verifiers into every later one.

/**
 * @typedef {object} ComponentState
 * @property {Promise<object> | undefined} supervisor What startup produced, joined by a second call and by
 *   the status endpoint. Its presence is the single-start guarantee.
 * @property {string | undefined} pidDir Where the guard's locks live. The read path re-reads the reaper's.
 * @property {string | undefined} traceLogPath The trace-agent's log; its refusal lines are the only
 *   trace-hop evidence this agent build gives.
 * @property {Map<string, Function>} verifiers Each process's own verifier, so the read path can retake a
 *   verdict a restart made stale.
 * @property {object[]} started What startup left running, read by the series timer rather than captured.
 * @property {{ stop(): void } | undefined} series This thread's metric timer, kept so a second startup
 *   cannot leave two of them running.
 */

/** @returns {ComponentState} */
export function createState() {
	return {
		supervisor: undefined,
		pidDir: undefined,
		traceLogPath: undefined,
		verifiers: new Map(),
		started: [],
		series: undefined,
	};
}

// -- Keeping the probes out of the host's APM -------------------------------------------------------------
//
// This component polls the agents before they bind, when polls fail, and on the line this replaces those
// failures became errored client spans on the customer's own service. The polling itself is the guard's; what
// only a Datadog consumer can say is how to make dd-trace ignore it.

// The store dd-trace keeps its OWN agent traffic out of the customer's APM with, applied to these probes for
// the same reason. Private path, so a miss falls back to untraceAgentProbes, which is the public half of this.
const untraced = (() => {
	try {
		const core = createRequire(import.meta.url)(
			"dd-trace/packages/datadog-core"
		);
		const legacy = core.storage("legacy");
		return (/** @type {() => any} */ run) => legacy.run({ noop: true }, run);
	} catch {
		return (/** @type {() => any} */ run) => run();
	}
})();

// Every probe the guard makes on this component's behalf runs inside it. Done at import rather than at wiring
// time: a poll issued before the wiring ran would be the one span this exists to prevent.
untraceWith(untraced);

// A process-global setting, so the next `tracer.use('http', ...)` from anywhere replaces it: dd-trace's
// configurePlugin overwrites a plugin's config rather than merging into it. Kept only as a fallback for
// releases where the private store above has moved; it cannot stand alone.
export function untraceAgentProbes(tracer, blocklist) {
	tracer.use("http", { client: { blocklist } }); // under `client`, or the server half drops inbound traces too
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
 * @param {import('@deliciousmonster/harper-process-guard').Log} log
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
			`${LABEL}: found dd-trace but could not configure it to ignore the agent probes: ${error.stack ?? error.message}. Probe requests may now appear as spans in APM.`
		);
		return { traced: false, reason: error.message };
	}
}

// -- Proving each process does its job --------------------------------------------------------------------
//
// What separates "the process is up" from "the process is the agent this node needs". A live process of the
// wrong kind, or a stray socket on the port, passes every cheaper check and is reported healthy.

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

// -- Whether anything reached Datadog ---------------------------------------------------------------------
//
// Three hops, read apart, because proving one proves nothing about the next. Every counter here is a
// one-minute window the agent resets, so nothing is cumulative and nothing diffs.

// Carried in the payload and bumped when the shape or the verdict set changes, so a consumer written against
// an older one can tell rather than guess.
const DELIVERY_SIGNAL_VERSION = 3;

/**
 * How long an accepted stats payload keeps vouching for the hop after its window has reset.
 *
 * Measured against 7.82.1 on 2026-09-09: `stats_writer` resets every 60 seconds and the writer flushes one
 * payload per 10, so `Payloads` reads zero for the first ten seconds of every window. A caller polling on a
 * 60-second period phase-locks into that band and reads zero minute after minute until its clock drifts out,
 * which is how a node with 2,483 spans arriving published `not-delivering`. Three windows is wide enough that
 * only a hop that has genuinely stopped falls out of it.
 */
export const STATS_RECALL_MS = 180_000;

const unavailable = (source, detail) => ({
	source,
	signalVersion: DELIVERY_SIGNAL_VERSION,
	verdict: "unavailable",
	detail,
});

/**
 * Three hops read apart, because proving one proves nothing about the next: spans into the local receiver,
 * APM stats into Datadog, trace payloads into Datadog.
 */
export function deliveryVerdict(vars, source, traceHop = null, history = null) {
	const clients = Array.isArray(vars?.receiver) ? vars.receiver : [];
	const sum = (field) =>
		clients.reduce((total, entry) => total + (Number(entry?.[field]) || 0), 0);
	const count = (writer, field) => Number(vars?.[writer]?.[field]) || 0;

	const receiver = {
		tracesReceived: sum("TracesReceived"),
		spansReceived: sum("SpansReceived"),
		clients: clients.map(
			(entry) => `${entry?.Lang ?? "?"} ${entry?.TracerVersion ?? "?"}`
		),
	};
	const statsWriter = {
		payloads: count("stats_writer", "Payloads"),
		errors: count("stats_writer", "Errors"),
		retries: count("stats_writer", "Retries"),
		buckets: count("stats_writer", "StatsBuckets"),
		clientPayloads: count("stats_writer", "ClientPayloads"),
	};
	const traceWriter = {
		payloads: count("trace_writer", "Payloads"),
		bytes: count("trace_writer", "Bytes"),
		errors: count("trace_writer", "Errors"),
		retries: count("trace_writer", "Retries"),
	};

	const arriving = receiver.tracesReceived > 0 || receiver.spansReceived > 0;
	// An empty stats window is not a failed hop. The counter resets on the minute and the read can land in the
	// ten seconds before the first flush, so what separates a stopped hop from that phase is how long it has
	// been since a window did accept something, which only a caller that remembers its last read can say.
	// A number and nothing else: `Number(null)` is zero, which would let a caller with no memory at all vouch
	// for every window it reads.
	const recalled = history?.statsAcceptedMsAgo;
	const acceptedMsAgo =
		typeof recalled === "number" && Number.isFinite(recalled) && recalled >= 0
			? recalled
			: undefined;
	const vouched =
		acceptedMsAgo !== undefined && acceptedMsAgo <= STATS_RECALL_MS;
	// The receiver snapshot is refreshed only when a payload arrives, so on a quiet node it is the last busy
	// minute. The concentrator builds buckets from received spans before anything is sent, so these date it.
	const thisMinute = statsWriter.buckets > 0 || statsWriter.clientPayloads > 0;
	const statsRefused = statsWriter.errors > 0 || statsWriter.retries > 0;
	// Read asymmetrically: two writers register into the one trace_writer expvar slot and the last one wins,
	// so a non-zero came from whichever did the work and is evidence, while a zero carries nothing at all.
	const tracesRefused = traceWriter.errors > 0 || traceWriter.retries > 0;

	const signal = {
		source,
		signalVersion: DELIVERY_SIGNAL_VERSION,
		agentVersion: vars?.version?.Version,
		receiver,
		statsWriter,
		traceWriter,
		// true is evidence the hop works, false evidence it does not, null no evidence either way.
		proven: {
			tracesAtReceiver: arriving ? true : null,
			statsAtDatadog:
				statsWriter.payloads > 0 ? true : statsRefused ? false : null,
			tracesAtDatadog:
				traceWriter.payloads > 0 ? true : tracesRefused ? false : null,
		},
	};

	// The trace hop, read from the writer's own failure lines when a log was given. Positive proof is not
	// available on this agent build; absence of a refusal inside the window is, and it is worth more than
	// the nothing this reported before.
	if (acceptedMsAgo !== undefined) signal.statsAcceptedMsAgo = acceptedMsAgo;
	if (traceHop)
		signal.traceHop = { refused: traceHop.refused, lines: traceHop.lines };
	if (traceHop?.refused) signal.proven.tracesAtDatadog = false;

	if (traceWriter.payloads > 0) {
		signal.verdict = "delivering";
		signal.detail = `the intake took ${traceWriter.payloads} trace payload(s), ${traceWriter.bytes} bytes, in the last minute.`;
	} else if (tracesRefused) {
		signal.verdict = "rejected";
		signal.detail = `every trace payload sent in the last minute came back refused (${traceWriter.retries} retries, ${traceWriter.errors} errors) and none were accepted. Check DD_API_KEY and DD_SITE.`;
	} else if (traceHop?.refused) {
		signal.verdict = "rejected";
		signal.detail =
			`the trace-agent logged ${traceHop.lines} refusal(s) of a trace payload inside the window ` +
			`(retry, drop, or an unexpected status). Check DD_API_KEY and DD_SITE.`;
	} else if (statsWriter.payloads > 0 && arriving && traceHop) {
		signal.verdict = "traces-unrefuted";
		signal.detail =
			`${receiver.spansReceived} spans reached the receiver and the intake accepted ` +
			`${statsWriter.payloads} APM stats payload(s), so the key, the site and the route out are good, ` +
			`and the trace-agent logged no refusal of a trace payload inside the window. trace_writer is not ` +
			`evidence either way: it publishes zeros on this agent build even while the writer delivers, which ` +
			`a stock container reproduces. This is the strongest statement available locally; the trace ` +
			`explorer is where a payload is seen to land.`;
	} else if (statsWriter.payloads > 0) {
		signal.verdict = "traces-unconfirmed";
		signal.detail =
			`the intake accepted ${statsWriter.payloads} APM stats payload(s) in the last minute, so the key, ` +
			`the site and the route out are good. Trace payloads are a separate hop on that route and nothing ` +
			`here proves one landed: trace_writer is zero, and on this agent build a zero is not a measurement. ` +
			`No trace-agent log was given, so not even a refusal could be ruled out. Confirm in the Datadog ` +
			`trace explorer.`;
	} else if (statsRefused) {
		signal.verdict = "rejected";
		signal.detail = `the intake refused every APM stats payload in the last minute (${statsWriter.retries} retries, ${statsWriter.errors} errors) and accepted none. Check DD_API_KEY and DD_SITE.`;
	} else if (arriving && vouched && traceHop && !traceHop.refused) {
		signal.verdict = "traces-unrefuted";
		signal.detail =
			`${receiver.spansReceived} spans reached the receiver and the intake accepted an APM stats payload ` +
			`${Math.round(acceptedMsAgo / 1000)}s ago, so the key, the site and the route out are good. This ` +
			`read landed in an empty stats window, which is the ten seconds before the writer's next flush and ` +
			`not a hop that stopped. The trace-agent logged no refusal of a trace payload inside the window, ` +
			`and trace_writer is not evidence either way: it publishes zeros on this agent build even while the ` +
			`writer delivers. The trace explorer is where a payload is seen to land.`;
	} else if (arriving && vouched) {
		signal.verdict = "traces-unconfirmed";
		signal.detail =
			`the intake accepted an APM stats payload ${Math.round(acceptedMsAgo / 1000)}s ago, so the key, the ` +
			`site and the route out are good. This read landed in an empty stats window rather than finding a ` +
			`hop that stopped. Nothing here proves a trace payload landed: trace_writer is zero, and on this ` +
			`agent build a zero is not a measurement. Confirm in the Datadog trace explorer.`;
	} else if (arriving && thisMinute) {
		signal.verdict = "not-delivering";
		signal.detail =
			`${receiver.spansReceived} spans reached the receiver this minute and neither the stats hop nor the ` +
			`traces hop has had anything accepted` +
			(acceptedMsAgo !== undefined
				? `, the last one ${Math.round(acceptedMsAgo / 1000)}s ago, longer than the ${STATS_RECALL_MS / 1000}s an empty window is allowed to be phase.`
				: `. Both windows reset every minute; read this again before believing it.`);
	} else if (arriving) {
		signal.verdict = "idle";
		signal.detail = `the receiver still reports ${receiver.spansReceived} spans while the stats writer saw no work at all, so that snapshot is left over from an earlier minute and nothing arrived in this one.`;
	} else {
		signal.verdict = "idle";
		signal.detail =
			"no spans reached the trace-agent in the last minute. Send the application some traffic and read this again; nothing here separates a quiet node from a dead tracer.";
	}
	return signal;
}

/**
 * Whether the trace hop was refused inside the window, read from the trace-agent's own log.
 *
 * The counter this module would rather use is dead: `trace_writer` publishes zeros on 7.82.1 even while
 * the writer delivers, and a stock `datadog/agent:7.82.1` container reproduces that with traces accepted
 * and no send failures, so it is not this build. Measured on the 2026-09-08 run: 14.3k spans reached
 * Datadog in fifteen minutes at exactly the configured sample rate while `trace_writer.Payloads` never
 * left zero. What the writer does report is failure. Every one of the 742 retries, 500 drops and 230
 * `Received unexpected status code` lines in twelve hours fell inside a wrong-key window, and the eight
 * hours of steady state produced none.
 *
 * So this is negative evidence, and it is only ever used to separate "refused" from "not refused". It
 * never claims a payload landed.
 *
 * @param {string | undefined} logFile @param {number} windowMs @param {number} [maxBytes]
 * @returns {{ refused: boolean, lines: number } | null} null when the log cannot be read at all.
 */
export function readTraceHop(
	logFile,
	windowMs = 120_000,
	maxBytes = 64 * 1024
) {
	if (!logFile) return null;
	const tail = tailFile(logFile, maxBytes);
	if (tail === null) return null;
	const cutoff = Date.now() - windowMs;
	let lines = 0;
	for (const line of tail.split("\n")) {
		if (!REFUSAL.test(line)) continue;
		// `2026-09-09 03:14:39 UTC | TRACE | WARN | ...`
		const stamp = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/.exec(line);
		if (!stamp) continue;
		const at = Date.parse(`${stamp[1]}Z`);
		if (Number.isFinite(at) && at >= cutoff) lines++;
	}
	return { refused: lines > 0, lines };
}

/** What the writer logs when the intake turns a payload away. Nothing here fires on a successful send. */
const REFUSAL =
	/Trace Payload dropped|Dropping Payload after|Retried payload|Received unexpected status code/;

/**
 * When the intake was last seen to accept an APM stats payload, per source.
 *
 * The verdict is a pure read of one window, and one window cannot tell a stopped hop from a read that landed
 * before the flush. This is the whole of the state this module holds, keyed by source so two ports on one node
 * do not vouch for each other, and shared across the node's threads because Harper answers a status read on
 * whichever thread is free.
 *
 * @param {string | undefined} dir
 */
export const sharedStatsStore = (dir) => sharedMarks(dir, "stats-accepted");

// This thread's own memory, which is all a single-threaded caller needs. Rebindable so a test can start from
// a cold one; nothing else replaces it.
let threadStore = sharedStatsStore(undefined);

/** Forget what was seen, for a test that needs a cold module. */
export const forgetStatsHistory = () => {
	threadStore = sharedStatsStore(undefined);
};

/**
 * How long ago this source last accepted a stats payload, recording this read as it answers.
 *
 * Read and write are one call because the order is the whole correctness of it: answer from what the previous
 * read left, then record, so a window that accepts is never its own corroboration.
 */
export function recallStatsWindow(
	source,
	payloads,
	at = Date.now(),
	store = threadStore
) {
	const seen = store.get(source);
	if (payloads > 0) store.set(source, at);
	return seen === undefined ? undefined : at - seen;
}

/** The trace-agent's own delivery counters. Never rejects: an endpoint that does not answer is itself a verdict. */
export async function readSignal(
	port,
	{ traceLog, markDir, now = Date.now } = {}
) {
	const source = debugVarsUrl(port);
	if (port === 0) {
		return unavailable(
			source,
			"apm_config.debug.port is 0 (DD_APM_DEBUG_PORT), so the trace-agent publishes no expvar to read."
		);
	}
	// One attempt, because a status endpoint answers now or reports that nothing did; waiting out a bind is
	// what the start-up verifies already do.
	const body = await pollEndpoint({
		url: source,
		timeoutMs: 1000,
		giveUp: () => true,
	});
	if (body === null) {
		return unavailable(
			source,
			`nothing answered ${source}, so no trace-agent is running on this node, or the one that is does not serve apm_config.debug.port.`
		);
	}
	const vars = parseJson(body);
	if (vars === null)
		return unavailable(
			source,
			`${source} answered with something that is not expvar JSON.`
		);
	const statsAcceptedMsAgo = recallStatsWindow(
		source,
		Number(vars?.stats_writer?.Payloads) || 0,
		now(),
		sharedStatsStore(markDir)
	);
	return deliveryVerdict(vars, source, readTraceHop(traceLog), {
		statsAcceptedMsAgo,
	});
}

// -- What the processes cost ------------------------------------------------------------------------------
//
// `system.processes.*` is the Python `process` integration and this build ships no Python; Live Processes is Go
// and running, but it publishes to the Processes intake rather than the metrics intake, so nothing in it is
// queryable or alertable. Measured on the shipped binary: no `process.*` or `system.*` metric name is compiled
// in at all. This is the named series something can alert on.
//
// It publishes under `system.processes.*`, the namespace the Python check uses, because a series under a
// private name is one nobody's existing dashboard or monitor finds. It was `harper.processes.*` first, on the
// argument that Datadog does not reserve the namespace so a counterfeit would be accepted and two sources
// would merge. That risk is real; it is answered rather than avoided. This build has no interpreter, so the
// `process` check cannot run in the agent this component spawns, and a live `conf.d/process.d/conf.yaml` makes
// this stand down. `DD_HARPER_PROCESS_METRICS_PREFIX` restores the private namespace for a node that wants the
// separation.
//
// What is filled is a subset. `process.py` also emits cpu.pct, mem.vms, open_file_descriptors, the io counters
// and the page-fault rates, all of which need /proc reads this does not do. A dashboard that charts those
// beside mem.rss shows one series populated and the rest empty, which is the cost of sharing the namespace and
// is stated on the status endpoint rather than left to be discovered.

/**
 * What this node sends, and how often.
 *
 * A boolean, not the presence of a config file. Datadog gates an *integration* on a `conf.d/<check>.d/`
 * file because the agent cannot know what you want monitored; `process.py` refuses an instance without a
 * `search_string`, `pid` or `pid_file` for exactly that reason. This is not an integration. It measures the
 * processes this component spawned, so it knows its own subject, which puts it in the same class as
 * `apm_config.enabled` and `process_config.process_collection.enabled` -- both of which this package already
 * renders as booleans. Installing the plugin is the operator asking for the data.
 *
 * On by default, because the series is small: six gauges per group, tagged by env, host and group. The cost
 * knobs are the ones an operator already knows from the check this replaces, with Datadog's own semantics:
 * `min_collection_interval` for cadence and `metric_patterns` where exclude beats include on overlap.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function seriesSettings(env = process.env) {
	const flag = env.DD_HARPER_PROCESS_METRICS_ENABLED;
	const seconds = Number(env.DD_HARPER_PROCESS_METRICS_INTERVAL);
	const patterns = (raw) =>
		(raw ?? "")
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);
	const prefix = String(env.DD_HARPER_PROCESS_METRICS_PREFIX ?? "").trim();
	return {
		// Anything but an explicit falsehood is on, so a typo cannot silently stop the data.
		enabled: !["false", "0", "no", "off"].includes(
			String(flag ?? "").toLowerCase()
		),
		intervalSeconds:
			Number.isFinite(seconds) && seconds > 0
				? seconds
				: DEFAULT_INTERVAL_SECONDS,
		// A trailing dot is the mistake an operator makes here, and it would put `system.processes..number`
		// on the wire, so it is stripped rather than honoured.
		prefix: prefix ? prefix.replace(/\.+$/, "") : DEFAULT_PREFIX,
		include: patterns(env.DD_HARPER_PROCESS_METRICS_INCLUDE),
		exclude: patterns(env.DD_HARPER_PROCESS_METRICS_EXCLUDE),
	};
}

/**
 * The namespace the Python `process` check publishes, which is the one a stock dashboard queries.
 *
 * Publishing here was the wrong call the first time. The argument against it was that Datadog does not
 * reserve the namespace server-side, so a counterfeit would be accepted and two sources would merge
 * silently. That risk is real and it is not this package's: this build excludes Python, so the `process`
 * check cannot run in the agent this component spawns, and `standDownFor` below covers the case where an
 * operator has arranged for something else to fill the namespace.
 *
 * What the argument missed is who pays. A series under a private name is one nobody's existing dashboard or
 * monitor finds, so "the data is there under a different name" costs the operator the work of rewriting
 * every query, which is the opposite of what shipping it was for.
 *
 * The metric names underneath were already Datadog's: `number`, `threads`, `mem.rss`, and `.avg`/`.max`/
 * `.min` are read straight off `ATTR_TO_METRIC` in `process.py`. Only the prefix and the tag key differed.
 */
export const DEFAULT_PREFIX = "system.processes";

/** What this package used before, kept as the documented way to opt out of sharing the namespace. */
export const PRIVATE_PREFIX = "harper.processes";

/**
 * Whether something else on this node is already filling `system.processes.*`, so this should stand down.
 *
 * The signal is a live `conf.d/process.d/conf.yaml`. That is how the agent is told to run the Python
 * `process` check, and Datadog ships only a `conf.yaml.example`, so a real one is an operator's deliberate
 * act. This build cannot run that check today, having no interpreter, but the file still says what the
 * operator intends and standing down on it is what keeps a later change from producing two sources.
 *
 * Not detectable from here: a second, separate Datadog agent on the same host with the check configured.
 * Nothing this process can read distinguishes that from no agent at all, so an operator in that position
 * sets DD_HARPER_PROCESS_METRICS_PREFIX and the detail line on the status endpoint says so.
 *
 * @param {string | undefined} confdDir @param {(p: string) => unknown} [stat]
 */
export function standDownFor(confdDir, stat = undefined) {
	if (!confdDir) return false;
	const exists = stat ?? ((p) => existsSync(p));
	for (const name of ["conf.yaml", "conf.yml"])
		if (exists(join(confdDir, "process.d", name))) return true;
	return false;
}

/**
 * Datadog's `metric_patterns` semantics: include narrows, exclude removes, exclude wins on overlap.
 *
 * @param {Record<string, number>} metrics
 * @param {{ include?: readonly string[], exclude?: readonly string[] }} patterns
 */
export function applyPatterns(metrics, { include = [], exclude = [] } = {}) {
	const matches = (list, name) =>
		list.some((p) => {
			try {
				return new RegExp(p).test(name);
			} catch {
				// A malformed pattern matches nothing rather than throwing a status read.
				return false;
			}
		});
	return Object.fromEntries(
		Object.entries(metrics).filter(
			([name]) =>
				(include.length === 0 || matches(include, name)) &&
				!matches(exclude, name)
		)
	);
}

/** Datadog's own default cadence for a check, so the number an operator knows carries over. */
export const DEFAULT_INTERVAL_SECONDS = 15;

/**
 * The aggregation the Python check publishes, over whatever this node could read.
 *
 * `number` counts what was found, not what was asked for: a supervised process the platform cannot measure
 * is absent from the series rather than present as a zero, so a monitor sees no data instead of a false floor.
 *
 * @param {readonly ({ rssBytes: number, threads: number } | null)[]} samples
 */
export function aggregate(samples) {
	const found = samples.filter((s) => s !== null);
	if (found.length === 0) return { number: 0 };
	const rss = found.map((s) => s.rssBytes);
	const threads = found.map((s) => s.threads);
	return {
		number: found.length,
		"mem.rss": rss.reduce((a, b) => a + b, 0),
		"mem.rss.avg": Math.round(rss.reduce((a, b) => a + b, 0) / rss.length),
		"mem.rss.max": Math.max(...rss),
		"mem.rss.min": Math.min(...rss),
		threads: threads.reduce((a, b) => a + b, 0),
	};
}

/** A DogStatsD tag list, sorted so two identical readings produce one series rather than two. */
const tagList = (tags) =>
	Object.entries(tags)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}:${String(v).replace(/[|,#\n]/g, "_")}`)
		.sort();

/**
 * The wire form. Gauges only: every field here is a level, and a counter would be wrong on a restart.
 *
 * @param {string} prefix @param {Record<string, number>} metrics @param {Record<string, string>} tags
 */
export function dogstatsdLines(prefix, metrics, tags = {}) {
	const suffix = tagList(tags);
	const tail = suffix.length ? `|#${suffix.join(",")}` : "";
	return Object.entries(metrics)
		.filter(([, v]) => Number.isFinite(v))
		.map(([name, value]) => `${prefix}.${name}:${value}|g${tail}`);
}

/**
 * One reading for one named process group, ready to send.
 *
 * @param {{ name: string, pid?: number, self?: boolean }[]} members
 * @param {{ group: string, prefix?: string, tags?: Record<string,string>, platform?: string }} options
 */
export function processSeries(members, options) {
	const {
		group,
		prefix = DEFAULT_PREFIX,
		tags = {},
		platform = process.platform,
	} = options;
	const samples = members.map((m) =>
		m.self ? selfProcess() : readProcess(m.pid, platform)
	);
	const metrics = applyPatterns(aggregate(samples), options);
	return {
		metrics,
		measured: samples.filter((s) => s !== null).length,
		asked: members.length,
		// `process_name` is what process.py tags with (`tags.extend(['process_name:{}'.format(self.name)...`)
		// and therefore what a stock dashboard groups by, so sharing the namespace without it would put the
		// data somewhere no existing query looks. `process_group` stays beside it: it is the same value under
		// the name this component's own status uses, and dropping it would break anything already built here.
		lines: dogstatsdLines(prefix, metrics, {
			...tags,
			process_name: group,
			process_group: group,
		}),
	};
}

// Which thread sends, arbitrated by the guard beside its own locks, so one directory holds everything this
// node decides. Harper loads this component into every worker thread and an ungated timer would emit the same
// gauges once per thread, multiplying `number` and `mem.rss` by the thread count.
export const CLAIM_FILE = "process-metrics.claim";

/**
 * Send one reading. UDP, because that is what DogStatsD listens on and what every tracer's runtime metrics
 * already use; a dropped packet costs one interval of one gauge and nothing retries it, which is the right
 * trade for a level that is resent 15 seconds later.
 *
 * @param {readonly string[]} lines
 * @param {{ port: number, host?: string, socket?: { send: Function, close: Function } }} options
 * @returns {Promise<number>} lines actually handed to the socket
 */
export async function sendDogstatsd(
	lines,
	{ port, host = "127.0.0.1", socket }
) {
	if (lines.length === 0) return 0;
	const own = socket ?? (await import("node:dgram")).createSocket("udp4");
	try {
		// One packet, newline-separated: DogStatsD reads a multi-metric payload, and one send beats six.
		const payload = Buffer.from(lines.join("\n"));
		await new Promise((resolve, reject) =>
			own.send(payload, port, host, (error) =>
				error ? reject(error) : resolve(undefined)
			)
		);
		return lines.length;
	} finally {
		if (!socket) own.close();
	}
}

/**
 * The cadence. One timer per thread, gated by the claim above, so the node emits one series however many
 * threads Harper runs.
 *
 * `members()` is called per tick rather than captured: the pids it reports change under chaos, and a captured
 * list would keep measuring a process the guard has already replaced.
 *
 * @param {object} options
 * @param {() => {name: string, pid?: number, self?: boolean}[]} options.members
 * @param {string} options.pidDir @param {string} options.holder @param {number} options.port
 * @param {Record<string,string>} [options.tags] @param {import("@deliciousmonster/harper-process-guard").Log} [options.log]
 * @param {NodeJS.ProcessEnv} [options.env] @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {typeof sendDogstatsd} [options.send]
 * @returns {{ stop: () => void, tick: () => Promise<'sent'|'not-owner'|'nothing'|'failed'>, intervalSeconds: number }}
 */
export function startProcessSeries({
	members,
	pidDir,
	holder,
	port,
	tags = {},
	log,
	env = process.env,
	setTimer = setInterval,
	send = sendDogstatsd,
}) {
	const resolved = seriesSettings(env);
	const groups = () => {
		const all = members();
		return [
			["harper", all.filter((m) => m.self)],
			["datadog-agents", all.filter((m) => !m.self)],
		].filter(([, m]) => m.length > 0);
	};
	const tick = async () => {
		if (
			!claimSingleton({
				dir: pidDir,
				file: CLAIM_FILE,
				holder,
				staleMs: claimStaleMs(resolved.intervalSeconds),
			})
		)
			return "not-owner";
		const lines = groups().flatMap(
			([group, m]) =>
				processSeries(m, {
					group,
					tags,
					prefix: resolved.prefix,
					include: resolved.include,
					exclude: resolved.exclude,
				}).lines
		);
		if (lines.length === 0) return "nothing";
		try {
			await send(lines, { port });
			return "sent";
		} catch (error) {
			// Once per failure, not once per tick forever: a DogStatsD that is down stays down for a while,
			// and a line a tick would bury the node's own logs under this component's retries.
			log?.warn?.(
				`${LABEL}: could not send the ${resolved.prefix}.* series to DogStatsD on ` +
					`127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`
			);
			return "failed";
		}
	};
	const timer = setTimer(() => {
		tick().catch(() => {});
	}, resolved.intervalSeconds * 1000);
	// A metrics timer must not be the reason a worker thread stays up.
	timer?.unref?.();
	return {
		stop: () => clearInterval(timer),
		tick,
		intervalSeconds: resolved.intervalSeconds,
		prefix: resolved.prefix,
	};
}

/**
 * Start this thread's own series timer and describe what it will do, for the status endpoint.
 *
 * Members are read per tick rather than captured, so a pid the guard replaced under chaos is measured as
 * the process the node runs now rather than the one it started. Only the claim holder sends; every other
 * thread's timer costs a file read.
 *
 * @param {object} options
 * @param {string} options.pidDir
 * @param {string} options.confd
 * @param {number} options.port DogStatsD.
 * @param {import('@deliciousmonster/harper-process-guard').Log} options.log
 * @param {() => Array<{name: string, pid?: number, self?: boolean}>} options.members
 * @param {{ stop(): void } | undefined} options.previous This thread's existing timer, stopped first so a
 *   second startup cannot leave two of them running.
 * @returns {{ state: object, series: { stop(): void } | undefined }}
 */
export function scheduleSeries({
	pidDir,
	confd,
	port,
	log,
	members,
	previous,
}) {
	const resolved = seriesSettings();
	if (!resolved.enabled) {
		previous?.stop();
		return {
			series: undefined,
			state: {
				...resolved,
				emitting: false,
				detail: `off: DD_HARPER_PROCESS_METRICS_ENABLED is ${process.env.DD_HARPER_PROCESS_METRICS_ENABLED}`,
			},
		};
	}
	// Sharing `system.processes.*` is only safe while nothing else fills it. A live conf.d/process.d/ is
	// the operator saying they intend the real check to, so this stands down rather than becoming a second
	// source.
	if (resolved.prefix === DEFAULT_PREFIX && standDownFor(confd)) {
		previous?.stop();
		return {
			series: undefined,
			state: {
				...resolved,
				emitting: false,
				detail:
					`standing down: ${join(confd, "process.d")} configures the Python \`process\` check, which owns ` +
					`${DEFAULT_PREFIX}.*. Set DD_HARPER_PROCESS_METRICS_PREFIX (${PRIVATE_PREFIX} is the documented ` +
					`alternative) to publish alongside it instead`,
			},
		};
	}
	previous?.stop();
	const series = startProcessSeries({
		pidDir,
		holder: `${process.pid}.${threadId}`,
		port,
		log,
		members,
	});
	return {
		series,
		state: {
			...resolved,
			emitting: true,
			detail:
				`sending ${series.prefix}.* to DogStatsD on 127.0.0.1:${port} every ` +
				`${series.intervalSeconds}s, from whichever thread holds the claim in ${pidDir}` +
				(series.prefix === DEFAULT_PREFIX
					? `. This is the namespace the Python \`process\` check owns, and this fills a subset of it: ` +
						`number, threads and mem.rss with its avg/max/min. cpu.pct, mem.vms, open_file_descriptors ` +
						`and the io counters are not collected and will read as no data`
					: ""),
		},
	};
}

// -- Who holds them up ------------------------------------------------------------------------------------
//
// The guard's supervisor with three things named: what this component calls itself in a log line, what its
// reaper's lock is called, and that its config files have to exist before anything spawns.

/**
 * @param {any} scope Harper's application scope.
 * @param {{ log: import('@deliciousmonster/harper-process-guard').Log, spawn: Function }} context
 */
export const supervisorFor = (scope, { log, spawn }) =>
	guardSupervisorFor(scope, {
		log,
		spawn,
		label: LABEL,
		reaperName: REAPER_NAME,
		// `supervision` is a field /DatadogStatus/ has published since this component shipped. The guard's
		// own word for the native path is "host"; changing what an operator reads is not a side effect a
		// refactor gets to have.
		nativeKind: "harper",
		// Harper's own start() writes these behind its sweep; on the guard's path nothing else will, and
		// every agent reads them.
		beforeStart: ({ configFiles }) => writeConfigFiles(configFiles, log),
	});

// -- What this node says about itself ---------------------------------------------------------------------
//
// One REST resource. Everything it reports fails silently by default, which is why it gets an endpoint at all.

/** Never the value itself, so the status endpoint cannot become a second place the key leaks. */
export const apiKeyStatus = () => (process.env.DD_API_KEY ? "set" : "MISSING");

/**
 * The fields every status shape starts from, so NOT_STARTED and a real startup cannot drift apart.
 *
 * @param {{ receiver: number }} ports
 */
export function baseStatus(ports) {
	return {
		receiverPort: ports.receiver,
		apiKey: apiKeyStatus(),
		// Settings this component resolved for itself, reported here rather than rendered into
		// datadog.yaml. That file's header says it is the agent's generated config, and the agent has no
		// idea these keys exist; writing them there would look like an agent setting that silently does
		// nothing. The ports above are in both because the agent genuinely reads those. This is the
		// plugin's own surface, so this is where the plugin says what it resolved.
		//
		// `emitting` is separate from `enabled` on purpose. It is what this thread's timer is actually
		// doing, so a thread that has not started yet, or one whose settings turned the series off, cannot
		// report a feature that sends nothing as if it were sending.
		processMetrics: {
			...seriesSettings(),
			emitting: false,
			detail:
				"startup has not run on this thread, so no cadence is scheduled here",
		},
		processes: [],
	};
}

/**
 * What a thread that has not started anything reports. The detail leads with the likeliest cause, because
 * a component Harper loaded by scanning componentsRoot reaches this and nothing else.
 *
 * @param {{ receiver: number }} ports
 * @param {string} configEntry
 */
export function notStarted(ports, configEntry) {
	return {
		...baseStatus(ports),
		detail:
			`nothing has started on this thread. Check first that the node's harper-config.yaml carries ` +
			`\`${configEntry}\`: Harper calls handleApplication only for a component the root config names, and ` +
			`a directory it loaded by scanning componentsRoot never reaches it. Otherwise this thread has not ` +
			`run startup yet, or it ran under a deploy validation load, which starts nothing`,
	};
}

/**
 * GET /DatadogStatus/, the plugin's one REST resource. Everything it reports fails silently by default,
 * which is why it gets an endpoint at all.
 *
 * @param {object} options
 * @param {Function} options.ResourceBase Harper's Resource, or a stub outside a compartment.
 * @param {ComponentState} options.state
 * @param {object} options.notStarted
 * @param {() => Promise<object>} options.readDeliverySignal
 */
export function createStatusResource({
	ResourceBase,
	state,
	notStarted,
	readDeliverySignal,
}) {
	return class DatadogStatus extends ResourceBase {
		static async get() {
			// The counters belong to the node's trace-agent, not to this thread, so they are read whether
			// or not this thread is the one that started it.
			const [status, delivery] = await Promise.all([
				state.supervisor ?? notStarted,
				readDeliverySignal(),
			]);
			return {
				...status,
				// Read here rather than copied at boot: a verdict the supervisor took before a restart
				// describes a process this node no longer runs.
				processes: await Promise.all(
					status.processes.map((process) =>
						// nodeProcess first: a thread that refused a handed-back pid has no process of its
						// own, and the verdict has to be retaken against the one the node actually runs.
						retakeVerdict(
							nodeProcess(process, state.pidDir, status.supervision),
							state.verifiers.get(process.name)
						)
					)
				),
				// Same reason as the verdicts above: a reaper the supervisor started can be gone, and until
				// this was read here the status reported the boot state and the dead pid with it.
				...(status.reaper
					? { reaper: currentReaper(status.reaper, state.pidDir, REAPER_NAME) }
					: {}),
				// Which thread answered; every field above it is per-thread state.
				threadId,
				delivery,
			};
		}
	};
}

// -- Starting them ----------------------------------------------------------------------------------------
//
// Resolve every declared binary, fingerprint what would make a running one stale, hand the set to the
// supervisor, and report what happened.

/**
 * @param {object} options
 * @param {readonly object[]} options.agents Declared processes, in start order.
 * @param {object} options.ports
 * @param {import('@deliciousmonster/harper-process-guard').Log} options.log
 * @param {Function} options.spawn Harper's constrained spawn.
 * @param {(ebpfDir: string | null) => object} options.prepareRuntime
 * @param {ComponentState} options.state
 */
export function createStart({
	agents,
	ports,
	log,
	spawn,
	prepareRuntime,
	state,
}) {
	/** The started state for one process on this thread, or undefined before startup produced one. */
	const startedProcess = (name) =>
		state.started.find((process) => process?.name === name);

	// Never rejects: a throw out of handleApplication plants an ErrorResource at the component's root path,
	// which is worse than running without telemetry and saying so.
	return async function start(scope) {
		const supervision = supervisorFor(scope, { log, spawn });
		const status = { supervision: supervision.kind, ...baseStatus(ports) };
		try {
			// Measured on 7.82.1 rather than inferred from one shared config, because the two agents fail
			// differently and an operator needs to know which silence they are looking at.
			if (!process.env.DD_API_KEY)
				log.warn(
					`${LABEL}: DD_API_KEY is not set. The core agent starts and collects, and the intake ` +
						"refuses every payload it sends with a 403. The trace-agent does not start at all: it exits " +
						'immediately with "you must specify an API Key", so nothing binds the receiver, the supervisor ' +
						"restarts it until it gives up, and dd-trace has nowhere to send spans."
				);

			// Before prepareRuntime, because the objects' path is written into the config it renders.
			const ebpfDir = await resolveEbpfDir();
			const runtime = prepareRuntime(ebpfDir);
			// The read path re-reads the reaper's lock, and this is the only place the path is known.
			state.pidDir = runtime.paths.pidDir;
			state.traceLogPath = runtime.paths.traceLog;
			Object.assign(status, {
				runtimeDir: runtime.paths.runtimeDir,
				configFile: runtime.paths.configFile,
				coreChecks: runtime.coreChecks,
				probes: probeStatus(runtime.probes, ebpfDir, { log }),
			});

			// Only what this node asked for. An optional process nobody enabled is not declared at all, so
			// it cannot be resolved, cannot fail to resolve, and cannot appear in the status as a thing
			// that broke.
			const wanted = agents.filter(
				(agent) => !agent.optional || agent.enabled(runtime.probes)
			);

			// Resolved up front so the fingerprint can never describe a different binary from the one spawned.
			const failures = [];
			const binaries = await Promise.all(
				wanted.map((agent, index) =>
					resolveBinary(agent).catch((error) => {
						failures[index] = error.message;
						// An optional process this node asked for and cannot find is the operator's own
						// misconfiguration to fix, not a defect: they set the flag and did not install the
						// package. It is still a refusal to run something requested, so it is logged.
						log.error(
							`${LABEL}: could not resolve the ${agent.title} binary: ${error.message}`
						);
						return "";
					})
				)
			);

			// The credentials ride in the inherited environment, invisible to the config contents, so a rotated
			// key must be folded in here or a thread joins an agent still posting under the old one.
			const fingerprintParts = [
				...Object.values(runtime.configFiles),
				process.env.DD_API_KEY ?? "",
				process.env.DD_SITE ?? "",
				process.env.DD_ENV ?? "",
				...binaries,
			];

			const verifyContext = { paths: runtime.paths, ports };
			const declared = wanted.map((agent, index) => ({
				...agent,
				command: binaries[index],
				args: agent.args(runtime.paths),
				verify: (launched) => verifyLaunch(agent, launched, verifyContext),
			}));

			// Reported here rather than inside a supervisor, so the two of them cannot describe the same
			// unresolvable binary in different words.
			state.verifiers = new Map(declared.map((a) => [a.name, a.verify]));
			const startable = declared.filter((agent) => agent.command);
			const started = startable.length
				? await supervision.start(startable, {
						root: runtime.root,
						pidDir: runtime.paths.pidDir,
						reaperLog: runtime.paths.reaperLog,
						replacementPidFile: runtime.root
							? join(runtime.root, "hdb.pid")
							: undefined,
						configFiles: runtime.configFiles,
						fingerprintParts,
					})
				: { processes: [], report: [] };

			const states = new Map(
				startable.map((agent, index) => [agent.name, started.processes[index]])
			);
			status.processes = declared.map(
				(agent, index) =>
					states.get(agent.name) ?? unstarted(agent, failures[index])
			);
			state.started = status.processes;
			if (started.reaper) status.reaper = started.reaper;
			if (started.report?.length) status.supervisionReport = started.report;

			const series = scheduleSeries({
				pidDir: runtime.paths.pidDir,
				confd: runtime.paths.confd,
				port: ports.dogstatsd,
				log,
				previous: state.series,
				members: () => [
					{ name: "harper", self: true },
					...agents
						.map((agent) => {
							const live = nodeProcess(
								startedProcess(agent.name),
								runtime.paths.pidDir
							);
							return { name: agent.name, pid: live?.pid };
						})
						.filter((member) => Number.isInteger(member.pid)),
				],
			});
			state.series = series.series;
			status.processMetrics = series.state;
		} catch (error) {
			status.error = error.message;
			log.error(`${LABEL}: startup failed: ${error.stack ?? error.message}`);
		}
		return status;
	};
}

// -- Wiring -----------------------------------------------------------------------------------------------
//
// A factory rather than a module of constants, and it has to be: resources.js is re-evaluated with a
// cache-busting query string in tests and the ports come from the environment, so state at module scope would
// be shared across evaluations and a port test would bind the first run's numbers forever.

/**
 * Wire this component up.
 *
 * @param {object} options
 * @param {Function} options.spawn Harper's constrained spawn, read in resources.js and handed down.
 * @param {object} [options.logger] Harper's compartment logger, or undefined outside a compartment.
 * @param {Function} [options.Resource] Harper's Resource base, or undefined outside a compartment.
 * @param {readonly string[]} options.processes Binary filenames, in start order. See runtime/datadog.js.
 */
export function datadog({ spawn, logger, Resource, processes }) {
	const log = normaliseLog(logger);
	const ports = resolvePorts(log);
	const agents = agentsFor(processes, ports);
	const state = createState();

	// Keep this component's own polling out of the host application's APM. Every probe already runs inside
	// dd-trace's own suppression store (see untraceWith above); this is the public half, and it holds only
	// until some other caller reconfigures the same plugins.
	suppressAgentProbes(
		[
			receiverInfoUrl(ports.receiver),
			expvarUrl(ports.expvar),
			debugVarsUrl(ports.debug),
		],
		log
	);

	// The root-config entry Harper needs before it calls the plugin at all. The key is the component
	// directory's name, because a root entry resolves to <componentsRoot>/<key>.
	const configEntry = `${basename(COMPONENT_DIR)}: { package: "${PACKAGE_NAME}" }`;

	/** The runtime tree and the config files for this node, rendered against this instance's ports. */
	const prepareRuntime = (ebpfDir = null) =>
		prepare(COMPONENT_DIR, { ports, log, ebpfDir });

	/** The trace-agent's delivery counters, off the debug port this instance rendered into datadog.yaml. */
	const readDeliverySignal = (port = ports.debug) =>
		readSignal(port, { traceLog: state.traceLogPath, markDir: state.pidDir });

	const handleApplication = createHandleApplication({
		start: createStart({
			agents,
			ports,
			log,
			spawn,
			prepareRuntime,
			state,
		}),
		deadline: watchForNeverCalled({
			log,
			label: LABEL,
			configEntry,
		}),
		slot: {
			get: () => state.supervisor,
			set: (promise) => (state.supervisor = promise),
		},
	});

	const DatadogStatus = createStatusResource({
		ResourceBase: Resource ?? class {},
		state,
		notStarted: notStarted(ports, configEntry),
		readDeliverySignal,
	});

	return {
		handleApplication,
		DatadogStatus,
		prepareRuntime,
		readDeliverySignal,
		AGENTS: agents,
	};
}
