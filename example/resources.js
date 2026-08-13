/**
 * Harper v5 REST resources that produce logs and traces, and that start the Datadog core
 * agent and trace-agent as one-per-node singletons.
 *
 * The relative import of ./dd-supervisor.js is load-bearing: Harper hands its constrained
 * child_process (allowlist, mandatory spawn name, PID-file lock) only to modules its own
 * loader compiles, and a relative specifier always takes that loader. The same supervisor in
 * an npm package that does not depend on `harper` is loaded natively with the real
 * child_process, silently losing the singleton. dd-supervisor.js checks for that at startup.
 */

// Bare specifier, so Harper resolves dd-trace natively, which is required rather than
// incidental. `threads.preloadRequire: dd-trace/init` initialises the tracer in the worker's
// CommonJS registry before any module loads, and resolving it natively here returns that same
// instance. Through Harper's application loader it would be a second copy in a private
// registry, one that never had init() called on it. An uninitialised dd-trace is not visibly
// inert: trace() still runs the callback and hands out spans with plausible trace ids, all of
// them NoopSpans. isTracerLive() separates the two.
import tracer from "dd-trace";
import { startDatadogAgents } from "./dd-supervisor.js";

/**
 * Started at component load, not on first request, and deliberately not awaited: a rejected
 * top-level await would fail the component load. startDatadogAgents() never rejects, and
 * holding the promise lets /DatadogStatus/ report the outcome.
 */
const supervisor = startDatadogAgents(import.meta.dirname);

/** Harper seeds every component compartment with `logger`; entries land in hdb.log. */
const log = typeof logger === "undefined" ? console : logger;

/**
 * Whether the span we were handed came from a real, initialised tracer. The uninitialised
 * tracer's scope never activates anything, so `scope().active()` is null inside its own
 * trace() callback while a live tracer returns the span itself. Unlike checking the trace id,
 * this cannot be fooled by the noop path.
 */
function isTracerLive(span) {
	return tracer.scope().active() === span;
}

/**
 * GET /Work/ produces a three-span trace and returns its trace id, so the same request can be
 * found in the Datadog UI. The spans are manual because that path does not depend on dd-trace
 * auto-instrumenting Harper's HTTP layer.
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

				// Harper renders a logged Error across many lines, none of which start with a
				// timestamp: the shape the multi_line rule in conf.d/harperdb.d/conf.yaml
				// reassembles. Without that rule each `at ...` frame arrives as its own log.
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
 * GET /DatadogStatus/ reports what the supervisor did: whether Harper's spawn interception is
 * live, where the runtime tree went, the PID of each agent. Everything here fails silently by
 * default, which is why it gets an endpoint.
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
