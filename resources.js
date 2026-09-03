// handleApplication(scope) is the only path that starts an agent, reachable only when a component's own
// config.yaml carries `pluginModule` beside `jsResource`. This is also the only file Harper compiles, so `spawn` and the compartment globals are read here and passed down: a helper importing them itself may get the unconstrained ones.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { threadId } from "node:worker_threads";

import { PACKAGE_NAME, resolveBinary } from "./runtime/binary.js";
import { prepareRuntime as prepare } from "./runtime/config.js";
import {
	debugVarsUrl,
	readDeliverySignal as readSignal,
} from "./runtime/delivery.js";
import { untraceAgentProbes } from "./runtime/probe.js";
import { supervisorFor, unstarted } from "./runtime/supervisor.js";
import { verifyLaunch } from "./runtime/verify.js";

/** Harper seeds every component compartment with `logger` and `Resource`; stubs keep the module importable in tests. */
const log = typeof logger === "undefined" ? console : logger;
const ResourceBase = typeof Resource === "undefined" ? class {} : Resource;

// Every method on Harper's Logger is declared optional, and the lines this module reports at info level have
// no second channel. Resolved per call, and down to `warn`, which it already relies on everywhere else.
const logInfo = (message) =>
	(log.info ?? log.warn ?? console.log).call(log, message);

/** Both agents read these variables, so an unparseable value must not be quietly reinterpreted. */
function resolvePort(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const trimmed = raw.trim();
	if (trimmed === "0") return 0; // upstream's spelling for "serve no endpoint here"
	// Whole-string, because parseInt reads "8126tcp" as 8126 and hands back a port nobody wrote.
	const parsed = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (parsed >= 1 && parsed <= 65535) return parsed;
	log.warn(
		`Datadog supervisor: ${name}="${raw}" is not a port in 1-65535. Using ${fallback}.`
	);
	return fallback;
}

// Read once per module instance, because every worker thread renders the config and probes the endpoints
// from the same three numbers and a second reading could disagree with the first.
const ports = {
	receiver: resolvePort("DD_APM_RECEIVER_PORT", 8126),
	expvar: resolvePort("DD_EXPVAR_PORT", 5000),
	debug: resolvePort("DD_APM_DEBUG_PORT", 5012),
};

// Every URL this module polls. probe.js already suppresses these at the call site; this is the public half,
// and it only holds until some other caller reconfigures the same plugins.
const PROBE_URLS = [
	`http://127.0.0.1:${ports.receiver}/info`,
	`http://127.0.0.1:${ports.expvar}/debug/vars`,
	debugVarsUrl(ports.debug),
];

// Resolved rather than imported: dd-trace belongs to the host application, and this package does not ship it.
try {
	untraceAgentProbes(createRequire(import.meta.url)("dd-trace"), PROBE_URLS);
} catch {
	// No tracer in this process, so there is nothing to keep the probes out of.
}

// `name` is Harper's spawn name and the PID-lock filename, stated once: a second spelling is a second lock
// and a second agent per node. The trace-agent comes first because it owns the socket dd-trace is dialing.
const AGENTS = [
	{
		kind: "trace",
		name: "datadog-trace-agent",
		title: "trace-agent",
		shipsAs: "trace-agent",
		// The trace-agent's `-c` takes the config FILE. Its own help text says directory and is wrong.
		args: (paths) => ["run", "-c", paths.configFile],
		exitHint: `An immediate non-zero exit from the trace-agent usually means something else already holds 127.0.0.1:${ports.receiver}.`,
	},
	{
		kind: "core",
		name: "datadog-agent",
		title: "core agent",
		shipsAs: "datadog-agent",
		args: (paths) => ["run", "-c", paths.runtimeDir],
	},
];

// The root-config entry Harper needs before it calls the plugin at all. The key is this directory's name,
// because a root entry resolves to <componentsRoot>/<key>.
const CONFIG_ENTRY = `${basename(import.meta.dirname)}: { package: "${PACKAGE_NAME}" }`;

/** The runtime tree and the config files for this node, rendered against the ports this instance resolved. */
export const prepareRuntime = () =>
	prepare(import.meta.dirname, { ports, log });

/** The trace-agent's delivery counters, off the debug port this instance rendered into datadog.yaml. */
export const readDeliverySignal = (port = ports.debug) => readSignal(port);

/** Per worker thread, set by handleApplication; a request that beats it, or a thread that never ran it, reads NOT_STARTED. */
let supervisor;

const NOT_STARTED = {
	receiverPort: ports.receiver,
	apiKey: process.env.DD_API_KEY ? "set" : "MISSING",
	processes: [],
	detail:
		`nothing has started on this thread. Check first that the node's harper-config.yaml carries ` +
		`\`${CONFIG_ENTRY}\`: Harper calls handleApplication only for a component the root config names, and ` +
		`a directory it loaded by scanning componentsRoot never reaches it. Otherwise this thread has not ` +
		`run startup yet, or it ran under a deploy validation load, which starts nothing`,
};

// Never rejects: a throw out of handleApplication plants an ErrorResource at the component's root path,
// which is worse than running without telemetry and saying so.
async function startAgents(scope) {
	const supervisor = supervisorFor(scope, { log, spawn });
	const status = {
		supervision: supervisor.kind,
		receiverPort: ports.receiver,
		apiKey: process.env.DD_API_KEY ? "set" : "MISSING",
		processes: [],
	};
	try {
		if (!process.env.DD_API_KEY) {
			log.warn(
				"Datadog supervisor: DD_API_KEY is not set. Both agents will start and the trace-agent will " +
					"accept spans, but the intake rejects the payloads. Nothing will appear in Datadog."
			);
		}

		const runtime = prepareRuntime();
		Object.assign(status, {
			runtimeDir: runtime.paths.runtimeDir,
			configFile: runtime.paths.configFile,
			coreChecks: runtime.coreChecks,
		});

		// Resolved up front so the fingerprint can never describe a different binary from the one spawned.
		const failures = [];
		const binaries = await Promise.all(
			AGENTS.map((agent, index) =>
				resolveBinary(agent).catch((error) => {
					failures[index] = error.message;
					log.error(
						`Datadog supervisor: could not resolve the ${agent.title} binary: ${error.message}`
					);
					return "";
				})
			)
		);

		// The credentials ride in the inherited environment, invisible to the config contents, so a rotated
		// key must be folded in here or the old one is posted forever.
		const fingerprintParts = [
			...Object.values(runtime.configFiles),
			process.env.DD_API_KEY ?? "",
			process.env.DD_SITE ?? "",
			process.env.DD_ENV ?? "",
			...binaries,
		];

		const verifyContext = { paths: runtime.paths, ports, logInfo };
		const declared = AGENTS.map((agent, index) => ({
			...agent,
			command: binaries[index],
			args: agent.args(runtime.paths),
			verify: (state) => verifyLaunch(agent, state, verifyContext),
		}));

		// Reported here rather than inside a supervisor, so the two of them cannot describe the same
		// unresolvable binary in different words.
		const startable = declared.filter((agent) => agent.command);
		const started = startable.length
			? await supervisor.start(startable, {
					runtime,
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
		if (started.reaper) status.reaper = started.reaper;
		if (started.report?.length) status.supervisionReport = started.report;
	} catch (error) {
		status.error = error.message;
		log.error(`Datadog supervisor: startup failed: ${error.message}`);
	}
	return status;
}

// 60s because handleApplication runs behind scope.ready and waitForDeployCompletion, then behind a per-plugin
// lock whose own wait is Harper's plugin timeout plus 5s: 35s at the 30s default. A shorter window libels a slow node.
const START_DEADLINE_MS = 60_000;

// The one failure this module cannot see from inside: Harper imports it for its resources and never calls
// the plugin, which is what an auto-scanned component directory gets. Module evaluation is the only vantage point left.
const startDeadline = setTimeout(() => {
	if (supervisor) return;
	log.error(
		`Datadog supervisor: Harper has not called handleApplication ${START_DEADLINE_MS / 1000}s after this ` +
			`module loaded, so no agent started and nothing on this node is supervising one. The likeliest ` +
			`cause is a component Harper loaded by scanning componentsRoot: it calls the plugin only for a ` +
			`component the root harper-config.yaml names, and the module it imports for a scanned directory ` +
			`is discarded.`
	);
	log.error(
		`Datadog supervisor: add this to the node's harper-config.yaml (the file settings_path names in ` +
			`~/.harperdb/hdb_boot_properties.file), keyed by this directory's name, then restart Harper: ${CONFIG_ENTRY}`
	);
}, START_DEADLINE_MS);
// A diagnostic must not be the reason a worker thread stays up.
startDeadline.unref?.();

/** Harper's plugin entry, once per worker thread, and the only path that starts anything. */
export function handleApplication(scope) {
	// Being called at all is what the deadline above waits for; a validation load counts, since Harper
	// reached the plugin either way.
	clearTimeout(startDeadline);
	// A deploy pre-flight loads the component against a live node just to validate it; starting agents there
	// re-enters the sweep and spawn path on every `harper deploy`.
	if (scope?.isTransientValidation) return;
	// The single-start guarantee: a second call joins the first promise rather than starting again.
	supervisor ??= startAgents(scope);
}

/** GET /DatadogStatus/, the plugin's one REST resource, reports what startup did. Everything it reports fails silently by default, which is why it gets an endpoint. */
export class DatadogStatus extends ResourceBase {
	static async get() {
		// The counters belong to the node's trace-agent, not to this thread, so they are read whether or not
		// this thread is the one that started it.
		const [status, delivery] = await Promise.all([
			supervisor ?? NOT_STARTED,
			readDeliverySignal(),
		]);
		return {
			...status,
			// Which thread answered; every field above it is per-thread state.
			threadId,
			delivery,
			// Run these from a shell, not from inside this process: an endpoint reached through the tracing
			// pipeline is itself traced, and reading it changes what it reports.
			verify: {
				receiver: `curl -s 127.0.0.1:${status.receiverPort}/info`,
				coreAgent: `curl -s 127.0.0.1:${ports.expvar}/debug/vars`,
				delivery: `curl -sk ${debugVarsUrl(ports.debug)}`,
			},
		};
	}
}
