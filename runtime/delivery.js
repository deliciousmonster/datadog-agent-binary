// Whether anything reached Datadog.
//
// Three hops, read apart, because proving one proves nothing about the next. Every counter here is a
// one-minute window the agent resets, so nothing is cumulative and nothing diffs.
//
// Nothing here starts or supervises anything. It reads, which is why the status endpoint can call it on a
// thread that started nothing and why a long run can poll it from outside the node.

import { debugVarsUrl } from "./datadog.js";
import {
	parseJson,
	pollEndpoint,
	sharedMarks,
	tailFile,
} from "@deliciousmonster/harper-process-guard";

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
