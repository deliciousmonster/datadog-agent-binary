// The Harper component: what it starts, what it watches, and what it says about itself.
//
// Everything Datadog declares is in runtime/datadog.js and arrives here as an import. The three things this
// file does with a running node are each their own module, because each has a caller besides the start path:
// runtime/verify.js proves a process is the agent this node needs, runtime/delivery.js reads back whether
// anything reached Datadog, runtime/series.js measures what the processes cost. What is left here is the
// lifecycle that joins them: start the processes that file describes, hold one start per node, and answer one
// REST resource with all of it.
//
// `spawn` and Harper's compartment globals arrive as arguments to datadog() at the bottom, because resources.js
// is the only file Harper compiles and so the only place they can be read. A module that imports `spawn`
// itself gets the unconstrained one, which is the whole reason the constrained one exists.

import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { threadId } from "node:worker_threads";

import {
	createHandleApplication,
	currentReaper,
	nodeProcess,
	normaliseLog,
	retakeVerdict,
	supervisorFor as guardSupervisorFor,
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
import { readSignal } from "./delivery.js";
import { scheduleSeries, seriesSettings } from "./series.js";
import { verifyLaunch } from "./verify.js";

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
/** @param {any} tracer @param {readonly string[]} blocklist */
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
			`${LABEL}: found dd-trace but could not configure it to ignore the agent probes: ${/** @type {Error} */ (error).stack ?? /** @type {Error} */ (error).message}. Probe requests may now appear as spans in APM.`
		);
		return { traced: false, reason: /** @type {Error} */ (error).message };
	}
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
 * @param {import("./datadog.js").Ports} ports
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
 * @param {import("./datadog.js").Ports} ports
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
 * @param {new () => object} options.ResourceBase Harper's Resource, or a stub outside a compartment.
 * @param {ComponentState} options.state
 * @param {Record<string, any>} options.notStarted
 * @param {() => Promise<any>} options.readDeliverySignal
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
			/** @type {[Record<string, any>, any]} */
			const [status, delivery] = await Promise.all([
				state.supervisor ?? notStarted,
				readDeliverySignal(),
			]);
			return {
				...status,
				// Read here rather than copied at boot: a verdict the supervisor took before a restart
				// describes a process this node no longer runs.
				processes: await Promise.all(
					status.processes.map((/** @type {any} */ process) =>
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
 * @param {readonly import("./datadog.js").Agent[]} options.agents Declared processes, in start order.
 * @param {import("./datadog.js").Ports} options.ports
 * @param {import('@deliciousmonster/harper-process-guard').Log} options.log
 * @param {Function} options.spawn Harper's constrained spawn.
 * @param {(ebpfDir: string | null) => import("./datadog.js").Runtime} options.prepareRuntime
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
	const startedProcess = (/** @type {string} */ name) =>
		state.started.find((/** @type {any} */ process) => process?.name === name);

	// Never rejects: a throw out of handleApplication plants an ErrorResource at the component's root path,
	// which is worse than running without telemetry and saying so.
	return async function start(scope) {
		const supervision = supervisorFor(scope, { log, spawn });
		/** @type {Record<string, any>} */
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
			/** @type {string[]} */
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
			const thrown = /** @type {Error} */ (error);
			status.error = thrown.message;
			log.error(`${LABEL}: startup failed: ${thrown.stack ?? thrown.message}`);
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
 * @param {new () => object} [options.Resource] Harper's Resource base, or undefined outside a compartment.
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
