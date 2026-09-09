// Whether anything this node collected reached Datadog. Every counter here is a one-minute window the agent
// resets, so nothing is cumulative and nothing diffs.

import { closeSync, openSync, readSync, statSync } from "node:fs";

import { parseJson, pollEndpoint } from "./probe.js";

// The trace-agent's own expvar, and https because it serves it under the self-signed IPC certificate.
// Stated once so the URL that is read and the `source` that is reported can never be different ports or schemes.
export const debugVarsUrl = (port) => `https://127.0.0.1:${port}/debug/vars`;

// Carried in the payload and bumped when the shape or the verdict set changes, so a consumer written against
// an older one can tell rather than guess.
const DELIVERY_SIGNAL_VERSION = 2;

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
export function deliveryVerdict(vars, source, traceHop = null) {
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
	} else if (arriving && thisMinute) {
		signal.verdict = "not-delivering";
		signal.detail = `${receiver.spansReceived} spans reached the receiver this minute and neither the stats hop nor the traces hop has had anything accepted. Both windows reset every minute; read this again before believing it.`;
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
	let tail;
	try {
		const { size } = statSync(logFile);
		const start = Math.max(0, size - maxBytes);
		const handle = openSync(logFile, "r");
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, size - start));
			readSync(handle, buffer, 0, buffer.length, start);
			tail = buffer.toString("utf-8");
		} finally {
			closeSync(handle);
		}
	} catch {
		return null;
	}
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

/** The trace-agent's own delivery counters. Never rejects: an endpoint that does not answer is itself a verdict. */
export async function readDeliverySignal(port, { traceLog } = {}) {
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
	return vars === null
		? unavailable(
				source,
				`${source} answered with something that is not expvar JSON.`
			)
		: deliveryVerdict(vars, source, readTraceHop(traceLog));
}
