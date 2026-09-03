// Every request this module makes is invisible to APM: the plugin polls the agents before they bind, when
// polls fail, and on the line this replaces those failures became errored client spans on the customer's own service.

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
	tracer.use("fetch", { blocklist }); // its own plugin extending the http client; use('http') never reaches it
}

/** A probe body as JSON, or null. Never throws: these bodies come off a socket and pollEndpoint's own contract is the same. */
export function parseJson(body) {
	try {
		return body === null ? null : JSON.parse(body);
	} catch {
		return null;
	}
}

/** GET over https accepting a self-signed certificate. Loopback only: never point this off 127.0.0.1. */
function fetchInsecure(url, timeoutMs) {
	return new Promise((resolve) => {
		const call = httpsRequest(
			url,
			{ rejectUnauthorized: false, timeout: timeoutMs },
			(response) => {
				const status = response.statusCode;
				if (status === undefined || status < 200 || status >= 300) {
					response.resume();
					resolve(null);
					return;
				}
				let body = "";
				response.setEncoding("utf-8");
				response.on("data", (chunk) => (body += chunk));
				response.on("end", () => resolve(body));
			}
		);
		call.on("timeout", () => call.destroy());
		call.on("error", () => resolve(null));
		call.end();
	});
}

// Both branches run under `untraced`: the span is created where the request is made, so that is the only
// place suppression cannot be undone by other code in the process.
async function probe(url, timeoutMs, insecureTls) {
	if (insecureTls) return untraced(() => fetchInsecure(url, timeoutMs));
	try {
		return await untraced(async () => {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(timeoutMs),
			});
			return response.ok ? await response.text() : null;
		});
	} catch {
		return null;
	}
}

// Swallowed on purpose: the report fires after a successful probe, so a throwing callback would otherwise
// cost the caller the body it already holds and break the never-throws guarantee.
function reportRetries(onRetried, attempts, waitedMs) {
	try {
		onRetried?.({ attempts, waitedMs });
	} catch {
		// A caller whose own logger is broken has no second channel to be told on.
	}
}

/** GET until something answers: the body text, or null on deadline or giveUp(). Never throws. */
// `intervalMs` is the first wait and every later one doubles up to MAX_INTERVAL_MS. The core agent binds its
// expvar port six to seven seconds after spawn, which a fixed 250ms retry pays for with ~120 probes a thread.
export async function pollEndpoint({
	url,
	timeoutMs = 30_000,
	intervalMs = 250,
	giveUp,
	insecureTls = false,
	onRetried,
}) {
	const started = Date.now();
	const deadline = started + timeoutMs;
	let interval = intervalMs;
	for (let attempts = 1; ; attempts++) {
		const budget = Math.min(
			PROBE_TIMEOUT_MS,
			Math.max(deadline - Date.now(), 1)
		);
		const body = await probe(url, budget, insecureTls);
		if (body !== null) {
			// Reported only when it had to wait: the failed probes go nowhere else, so a caller that wants a
			// slow bind on the record has this and nothing else to write it from.
			if (attempts > 1)
				reportRetries(onRetried, attempts, Date.now() - started);
			return body;
		}
		// Asked between probes, and only after one has failed, so a target that answered then died still counts.
		if (giveUp?.() || Date.now() >= deadline) return null;
		// Clamped to what is left: backing off must not spend the caller's budget asleep past the deadline.
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(interval, deadline - Date.now()))
		);
		interval = Math.min(interval * 2, MAX_INTERVAL_MS);
	}
}
