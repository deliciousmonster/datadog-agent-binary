// What the plugin says about itself, and the one REST resource that says it.
//
// The shape is mostly generic: a list of supervised processes, each with its own verdict, plus which
// thread answered. What is Datadog's is the API-key state, the receiver port and the delivery counters.
// When the supervision half moves to the guard, this file is where the seam runs.

import { threadId } from "node:worker_threads";

import { settings as processMetricSettings } from "./process-metrics.js";
import { currentReaper, nodeProcess } from "./supervisor.js";
import { retakeVerdict } from "./verify.js";

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
			...processMetricSettings(),
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
 * @param {import('./state.js').ComponentState} options.state
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
					? { reaper: currentReaper(status.reaper, state.pidDir) }
					: {}),
				// Which thread answered; every field above it is per-thread state.
				threadId,
				delivery,
			};
		}
	};
}
