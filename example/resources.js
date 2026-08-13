/**
 * Harper v5 REST resources that produce logs and traces, and that start the Datadog core
 * agent and trace-agent as one-per-node singletons.
 *
 * The relative import of ./dd-supervisor.js is not a style choice. Harper only hands its
 * constrained child_process (allowlist + mandatory name + PID-file lock) to modules its own
 * loader compiles, and `shouldUseApplicationLoader()` returns true unconditionally for a
 * relative specifier. Move the supervisor into an npm package that does not depend on
 * `harper` and it is loaded natively with the real child_process, which silently removes the
 * singleton. dd-supervisor.js checks for that at startup and says so.
 */

import tracer from "dd-trace";
import { startDatadogAgents } from "./dd-supervisor.js";

/**
 * `dd-trace` is a bare specifier, so Harper loads it natively -- which is required, not
 * incidental. `threads.preloadRequire: dd-trace/init` initialises the tracer in the worker's
 * CommonJS registry before any Harper or application module loads; resolving it natively here
 * returns that same initialised instance. Loading it through Harper's application loader would
 * evaluate a second copy in a private module registry, and that copy would never have had
 * init() called on it.
 *
 * An uninitialised dd-trace is not inert in a way you would notice. `tracer.trace()` still
 * runs the callback, still hands it a span, and `span.context().toTraceId()` still returns a
 * plausible random id -- it is just a NoopSpan that is never sent anywhere. isTracerLive()
 * below is what separates the two.
 */

/**
 * Kick the agents off at component load rather than on first request, but do not await here.
 * A rejected top-level await would fail the whole component load; startDatadogAgents() never
 * rejects, and holding the promise lets /DatadogStatus/ report the outcome.
 */
const supervisor = startDatadogAgents(import.meta.dirname);

/** Harper seeds every component compartment with `logger`; entries land in hdb.log. */
const log = typeof logger === "undefined" ? console : logger;

/**
 * Whether the span we were handed came from a real, initialised tracer.
 *
 * The uninitialised tracer's scope never activates anything, so `scope().active()` is null
 * inside its own trace() callback. A live tracer returns the span itself. This uses only the
 * public API and, unlike checking the trace id, it cannot be fooled by the noop path.
 */
function isTracerLive(span) {
	return tracer.scope().active() === span;
}

/**
 * GET /Work/ -- the endpoint worth tracing.
 *
 * Produces a three-span trace (one manual root, two manual children) so there is real
 * structure in the flame graph, and returns the trace id so the same request can be found in
 * the Datadog UI. The manual spans matter: they are the part of this that does not depend on
 * dd-trace successfully auto-instrumenting Harper's HTTP layer.
 */
export class Work extends Resource {
	static async get() {
		return tracer.trace(
			"harper.work.request",
			{
				resource: "GET /Work/",
				type: "web",
				tags: { component: "datadog-agent-binary-example" },
			},
			async (rootSpan) => {
				const live = isTracerLive(rootSpan);
				const traceId = rootSpan.context().toTraceId();
				const traceId128 = rootSpan.context().toTraceId(true);

				if (!live) {
					log.error(
						"Datadog example: dd-trace is NOT initialised on this worker thread. The " +
							"span below is a NoopSpan and will never reach the trace-agent, even " +
							"though it has a trace id. Set threads.preloadRequire: dd-trace/init in " +
							"harperdb-config.yaml and restart Harper. threads.preload alone is not " +
							"enough: dd-trace/register.js only installs loader hooks, it does not " +
							"call init()."
					);
				}

				log.info(`Datadog example: handling GET /Work/ in trace ${traceId}`);

				const sum = await tracer.trace(
					"harper.work.compute",
					{ resource: "sum-primes" },
					async (span) => {
						const total = sumPrimesBelow(20000);
						span.setTag("work.result", total);
						return total;
					}
				);

				const delayMs = await tracer.trace(
					"harper.work.io",
					{ resource: "simulated-io" },
					async (span) => {
						const ms = 25;
						await new Promise((resolve) => setTimeout(resolve, ms));
						span.setTag("work.delay_ms", ms);
						return ms;
					}
				);

				rootSpan.setTag("work.sum", sum);

				// A deliberate multi-line entry. Harper renders a logged Error with its full
				// stack across many lines, none of which start with a timestamp, which is
				// exactly the shape the multi_line rule in conf.d/harperdb.d/conf.yaml exists
				// to reassemble. Without that rule each `at ...` frame arrives in Datadog as
				// its own log.
				log.warn(
					"Datadog example: emitting a deliberate multi-line log entry to exercise the " +
						"multi_line processing rule",
					new Error(
						"This error is intentional. It is here for its stack trace."
					)
				);

				return {
					traceId,
					traceId128,
					tracerInitialized: live,
					service: process.env.DD_SERVICE || "harper",
					sum,
					delayMs,
					hint: live
						? `Search Datadog APM for trace_id:${traceId}`
						: "Spans are being discarded: dd-trace is not initialised on this thread.",
				};
			}
		);
	}
}

/**
 * GET /DatadogStatus/ -- what the supervisor actually did.
 *
 * Reports whether Harper's spawn interception is live, where the runtime tree went, and the
 * PID of each agent. Everything here fails silently by default, so it is worth an endpoint.
 */
export class DatadogStatus extends Resource {
	static async get() {
		const status = await supervisor;
		return {
			...status,
			tracerInitialized: tracer.trace("harper.status.probe", (span) =>
				isTracerLive(span)
			),
			verify: {
				receiver: `curl -s 127.0.0.1:${status.receiverPort}/info`,
				traces: "curl -s -u <user>:<pass> http://localhost:9926/Work/",
			},
		};
	}
}

/** Enough CPU work that the compute span has a visible duration. */
function sumPrimesBelow(limit) {
	let total = 0;
	for (let n = 2; n < limit; n++) {
		let prime = true;
		for (let d = 2; d * d <= n; d++) {
			if (n % d === 0) {
				prime = false;
				break;
			}
		}
		if (prime) total += n;
	}
	return total;
}
