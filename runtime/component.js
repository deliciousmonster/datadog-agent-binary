// Wiring. Every piece below lives in its own file; this one says how they connect and holds nothing of
// its own except the order.
//
// A factory rather than a module of constants, and it has to be: resources.js is re-evaluated with a
// cache-busting query string in tests and the ports come from the environment, so state at module scope
// would be shared across evaluations and a port test would bind the first run's numbers forever. Called
// once per evaluation, every reference below is fresh.
//
// `spawn` and Harper's compartment globals arrive as arguments because resources.js is the only file
// Harper compiles, so it is the only place they can be read. A module that imports `spawn` itself gets the
// unconstrained one, which is the whole reason the constrained one exists.

import { basename, dirname } from "node:path";

import { agentsFor } from "./agents.js";
import { PACKAGE_NAME } from "./binary.js";
import { prepareRuntime as prepare } from "./config.js";
import { debugVarsUrl, readDeliverySignal as readSignal } from "./delivery.js";
import { createHandleApplication, watchForNeverCalled } from "./lifecycle.js";
import { normaliseLog } from "./log.js";
import { resolvePorts } from "./ports.js";
import { suppressAgentProbes } from "./probe.js";
import { createStart } from "./start.js";
import { createState } from "./state.js";
import { createStatusResource, notStarted } from "./status.js";
import { expvarUrl, receiverInfoUrl } from "./verify.js";

// runtime/ sits directly under the component root, and the root is what Harper installs and what
// prepareRuntime renders against. Derived rather than passed, so resources.js has one less thing in it.
const COMPONENT_DIR = dirname(import.meta.dirname);

/**
 * Wire this component up.
 *
 * @param {object} options
 * @param {Function} options.spawn Harper's constrained spawn, read in resources.js and handed down.
 * @param {object} [options.logger] Harper's compartment logger, or undefined outside a compartment.
 * @param {Function} [options.Resource] Harper's Resource base, or undefined outside a compartment.
 * @param {readonly string[]} options.processes Binary filenames, in start order. See runtime/agents.js.
 */
export function datadog({ spawn, logger, Resource, processes }) {
	const log = normaliseLog(logger);
	const ports = resolvePorts(log);
	const agents = agentsFor(processes, ports);
	const state = createState();

	// Keep this component's own polling out of the host application's APM. probe.js suppresses these at
	// the call site too; this is the public half, and it holds only until some other caller reconfigures
	// the same plugins.
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
			packageName: PACKAGE_NAME,
			prepareRuntime,
			state,
		}),
		deadline: watchForNeverCalled({
			log,
			label: "Datadog supervisor",
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
