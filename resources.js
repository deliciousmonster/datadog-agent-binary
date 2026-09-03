// handleApplication(scope) is the only path that starts an agent. Harper hands a Scope only to a component
// its root config names, and only because config.yaml carries `pluginModule` beside `jsResource`.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { threadId } from "node:worker_threads";

import { describeExit, describeSpawnFailure } from "./agent-exit.js";
import { pollEndpoint, untraceAgentProbes } from "./probe.js";

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

const RECEIVER_PORT = resolvePort("DD_APM_RECEIVER_PORT", 8126);
const EXPVAR_PORT = resolvePort("DD_EXPVAR_PORT", 5000);

/** The path dd-trace posts spans to. A receiver that does not advertise it is not one this node can use. */
const TRACE_ENDPOINT = "/v0.4/traces";

// Every URL this module polls. probe.js already suppresses these at the call site; this is the public half,
// and it only holds until some other caller reconfigures the same plugins.
const PROBE_URLS = [
	`http://127.0.0.1:${RECEIVER_PORT}/info`,
	`http://127.0.0.1:${EXPVAR_PORT}/debug/vars`,
];

// Resolved rather than imported: dd-trace belongs to the host application, and this package does not ship it.
try {
	untraceAgentProbes(createRequire(import.meta.url)("dd-trace"), PROBE_URLS);
} catch {
	// No tracer in this process, so there is nothing to keep the probes out of.
}

const EXE = process.platform === "win32" ? ".exe" : "";

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
		exitHint: `An immediate non-zero exit from the trace-agent usually means something else already holds 127.0.0.1:${RECEIVER_PORT}.`,
	},
	{
		kind: "core",
		name: "datadog-agent",
		title: "core agent",
		shipsAs: "datadog-agent",
		args: (paths) => ["run", "-c", paths.runtimeDir],
	},
];

// Read here rather than taken from an environment variable this package invents: Harper reads the same chain
// for itself and exposes no root path to a component. Absolute or null, never throws.
function readHarperRootPath() {
	try {
		const boot = readFileSync(
			join(homedir(), ".harperdb", "hdb_boot_properties.file"),
			"utf-8"
		);
		// Java-style properties, and Harper indents every line after the first, so the whitespace class matters.
		const settingsPath = boot.match(
			/^[ \t]*settings_path[ \t]*=[ \t]*(.+?)[ \t]*$/m
		)?.[1];
		if (!settingsPath) return null;
		// rootPath is top level in harper-config.yaml: the one key readable off a single line without a parser.
		const rootPath = readFileSync(settingsPath, "utf-8")
			.match(/^rootPath[ \t]*:[ \t]*(.+?)[ \t]*(?:#.*)?$/m)?.[1]
			?.replace(/^(['"])(.*)\1$/, "$2");
		// Rejects `rootPath: null`, which Harper's own defaultConfig.yaml ships, and anything relative.
		return rootPath && isAbsolute(rootPath) ? rootPath : null;
	} catch {
		return null;
	}
}

/** Harper's root path, or null. ROOTPATH is the harper-pro image's own spelling and wins. */
const harperRoot = () => process.env.ROOTPATH || readHarperRootPath();

/** YAML-safe scalar; double quotes also survive Windows drive letters. */
const yamlString = (value) => JSON.stringify(String(value));

/** The datadog.yaml both agents read: every path off the unwritable Datadog defaults, ports pinned to the ones this file probes. */
function renderDatadogYaml(paths) {
	return [
		"# GENERATED by resources.js on every Harper worker start. Edits are overwritten.",
		"# api_key and site are absent by design: they ride in DD_API_KEY / DD_SITE, never on disk.",
		`confd_path: ${yamlString(paths.confd)}`,
		`run_path: ${yamlString(paths.run)}`,
		`auth_token_file_path: ${yamlString(paths.authToken)}`,
		`ipc_cert_file_path: ${yamlString(paths.ipcCert)}`,
		"# The agents log under the runtime tree; a stdio pipe would tie them to one worker thread.",
		"log_to_console: false",
		`log_file: ${yamlString(paths.coreLog)}`,
		// Both agents read these same top-level keys; apm_config has no rotation settings of its own.
		// 5 MiB by 2 rolls bounds each log file at 15 MiB, against a default that bounds nothing here.
		'log_file_max_size: "5Mb"',
		"log_file_max_rolls: 2",
		"# Loopback only. Nothing here should be reachable from outside the container.",
		'bind_host: "127.0.0.1"',
		"# Pinned because the core-agent verify reads expvar off this port.",
		`expvar_port: ${EXPVAR_PORT}`,
		"apm_config:",
		"  enabled: true",
		`  receiver_port: ${RECEIVER_PORT}`,
		"  # On, this binds 0.0.0.0 and accepts spans from anything that reaches the container.",
		"  apm_non_local_traffic: false",
		`  log_file: ${yamlString(paths.traceLog)}`,
		"",
	].join("\n");
}

/** The shipped core checks that apply here; an optional `platforms` file beside a check gates it, absent means everywhere. */
function collectCoreChecks(packageConfd) {
	const checks = [];
	const entries = readdirSync(packageConfd, { withFileTypes: true }).sort(
		(a, b) => (a.name < b.name ? -1 : 1)
	);
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.endsWith(".d")) continue;
		const source = join(packageConfd, entry.name, "conf.yaml.default");
		if (!existsSync(source)) continue;
		const gate = join(packageConfd, entry.name, "platforms");
		if (existsSync(gate)) {
			const platforms = readFileSync(gate, "utf-8")
				.replace(/#.*$/gm, "")
				.split(/\s+/)
				.filter(Boolean);
			if (!platforms.includes(process.platform)) continue;
		}
		checks.push({
			dir: entry.name,
			name: entry.name.slice(0, -".d".length),
			body: readFileSync(source, "utf-8"),
		});
	}
	return checks;
}

/** This start owns exactly the conf.yaml.default files. One nobody claims was left by an older version on a persistent volume; an operator's own conf.yaml is never touched. */
function removeStaleDefaults(confd, owned) {
	for (const entry of readdirSync(confd, { withFileTypes: true })) {
		if (entry.isDirectory() && !owned.has(entry.name)) {
			rmSync(join(confd, entry.name, "conf.yaml.default"), { force: true });
		}
	}
}

// The runtime tree lives under Harper's root, never the component directory, which `harper deploy` replaces
// under a live agent. Without the core-check configs the agent runs, reports healthy and collects no host metric.
export function prepareRuntime(componentDir) {
	const root = harperRoot();
	const runtimeDir = root
		? join(root, "datadog")
		: join(homedir(), ".harper-datadog");
	const paths = {
		runtimeDir,
		configFile: join(runtimeDir, "datadog.yaml"),
		confd: join(runtimeDir, "conf.d"),
		run: join(runtimeDir, "run"),
		authToken: join(runtimeDir, "run", "auth_token"),
		ipcCert: join(runtimeDir, "run", "ipc_cert.pem"),
		coreLog: join(runtimeDir, "logs", "agent.log"),
		traceLog: join(runtimeDir, "logs", "trace-agent.log"),
	};
	mkdirSync(paths.run, { recursive: true });
	mkdirSync(join(runtimeDir, "logs"), { recursive: true });
	mkdirSync(paths.confd, { recursive: true });

	const configFiles = { [paths.configFile]: renderDatadogYaml(paths) };
	let checks = [];
	try {
		checks = collectCoreChecks(join(componentDir, "conf.d"));
		for (const check of checks) {
			configFiles[join(paths.confd, check.dir, "conf.yaml.default")] =
				check.body;
		}
		removeStaleDefaults(paths.confd, new Set(checks.map((check) => check.dir)));
	} catch (error) {
		log.warn(
			`Datadog supervisor: no core check configuration was collected (${error.message}), so the agent ` +
				`will report healthy and collect no host metrics. Traces are unaffected.`
		);
	}

	return {
		root,
		paths,
		configFiles,
		coreChecks: checks.map((check) => check.name),
	};
}

// Constant, never derived: a deployed component's nearest package.json can carry any name, and a wrong base
// resolves a platform package that does not exist.
const PACKAGE_NAME = "@harperfast/datadog-agent-binary";

// The root-config entry Harper needs before it calls the plugin at all. The key is this directory's name,
// because a root entry resolves to <componentsRoot>/<key>.
const CONFIG_ENTRY = `${basename(import.meta.dirname)}: { package: "${PACKAGE_NAME}" }`;

/** This package's platform label for the running host; throws where no platform package exists. */
function platformName() {
	const os = { linux: "linux", darwin: "macos", win32: "windows" }[
		process.platform
	];
	const arch = { x64: "x86_64", arm64: "arm64" }[process.arch];
	if (!os || !arch) {
		throw new Error(
			`unsupported platform: ${process.platform}-${process.arch}`
		);
	}
	return `${os}-${arch}`;
}

/** The platform package's accessor first (the npm install path), then a dev checkout's build output. */
export async function resolveBinary(agent) {
	const file = `${agent.shipsAs}${EXE}`;
	const platformPackage = `${PACKAGE_NAME}-${platformName()}`;
	try {
		const pkg = await import(platformPackage);
		const getBinaryPath = pkg.getBinaryPath ?? pkg.default?.getBinaryPath;
		const resolved = getBinaryPath?.(agent.shipsAs);
		// Checked by name: a package published before the trace-agent shipped answers every request with
		// the core agent, and that path exists, so trusting it starts two core agents and no receiver.
		if (resolved && basename(resolved) === file && existsSync(resolved)) {
			return resolved;
		}
	} catch {
		// The optional dependency is not installed here; the dev-checkout path below still applies.
	}
	const local = join(import.meta.dirname, "build", platformName(), "bin", file);
	if (existsSync(local)) return local;
	throw new Error(
		`no ${agent.title} binary: neither ${platformPackage} nor a local build at ${local} resolved ${file}`
	);
}

/** Parse JSON without throwing; the probe bodies come off a socket. */
function parseJson(body) {
	try {
		return body === null ? null : JSON.parse(body);
	} catch {
		return null;
	}
}

// One line per thread per boot, and only where the endpoint made us wait. The failed probes are suppressed
// by design, so without this a bind that took seconds leaves nothing behind on the node at all.
const slowBindLogger =
	(title, url) =>
	({ attempts, waitedMs }) =>
		logInfo(
			`Datadog supervisor: thread ${threadId} waited ${waitedMs}ms over ${attempts} probes for ${title} to answer ${url}.`
		);

/** What the process did, when it did anything. A signalled exit reports no code, so `code || 0` reads it as a clean stop. */
function exitDetail(state) {
	if (state?.exited !== true) return "";
	if (typeof state.signal !== "string" && typeof state.code !== "number") {
		return " The process this node started is gone.";
	}
	const { detail } = describeExit(state.code ?? null, state.signal ?? null);
	return ` The process this node started ${detail}.`;
}

/** Prove the trace-agent serves the endpoint dd-trace posts to; a bare TCP connect is satisfied by any stray socket, and dd-trace reports a successful flush either way. */
async function verifyTraceAgent(state, paths) {
	if (RECEIVER_PORT === 0) {
		return {
			ok: false,
			detail:
				"apm_config.receiver_port is 0 (DD_APM_RECEIVER_PORT): the HTTP receiver is off, and " +
				"dd-trace drops every span unless it is pointed at a Unix socket instead",
		};
	}
	const url = `http://127.0.0.1:${RECEIVER_PORT}/info`;
	const body = await pollEndpoint({
		url,
		giveUp: () => state.exited === true,
		onRetried: slowBindLogger("the APM receiver", url),
	});
	const endpoints = parseJson(body)?.endpoints;
	const serving =
		Array.isArray(endpoints) &&
		endpoints.some(
			(entry) => typeof entry === "string" && entry.includes(TRACE_ENDPOINT)
		);
	if (serving) {
		return {
			ok: true,
			detail: `the APM receiver serves ${TRACE_ENDPOINT} on 127.0.0.1:${RECEIVER_PORT}; dd-trace has somewhere to send spans`,
		};
	}
	return {
		ok: false,
		detail:
			body === null
				? `nothing answered ${url}, so dd-trace has nowhere to send spans.${exitDetail(state)} ` +
					`Check apm_config.enabled in ${paths.configFile} and DD_APM_ENABLED, then read ${paths.traceLog}`
				: `whatever answered ${url} does not advertise ${TRACE_ENDPOINT}, so it is not a trace-agent this node can rely on`,
	};
}

/** Prove the process behind the lock is a core agent: only it publishes aggregator and forwarder, and a live process of the wrong kind passes every cheaper check. */
async function verifyCoreAgent(state, paths) {
	if (EXPVAR_PORT === 0) {
		return {
			ok: false,
			detail:
				"expvar_port is 0 (DD_EXPVAR_PORT), so nothing can confirm the core agent is the process " +
				"holding its PID lock, and no host metric can be shown to be collected",
		};
	}
	const url = `http://127.0.0.1:${EXPVAR_PORT}/debug/vars`;
	const vars = parseJson(
		await pollEndpoint({
			url,
			giveUp: () => state.exited === true,
			onRetried: slowBindLogger("the core agent", url),
		})
	);
	if (!vars || !("aggregator" in vars) || !("forwarder" in vars)) {
		return {
			ok: false,
			detail:
				`nothing answering ${url} identified itself as a core agent, so host metrics and tags are ` +
				`going nowhere while traces may still flow.${exitDetail(state)} A stale PID lock adopted by ` +
				`the wrong process produces exactly this; read ${paths.coreLog} and check ${paths.configFile}`,
		};
	}
	if (typeof vars.pid === "number" && vars.pid !== state.pid) {
		return {
			ok: false,
			detail: `a core agent answered ${url} as pid ${vars.pid}, not the pid ${state.pid} this node holds the lock for; remove the stale .pid file under the node's pids/ directory and restart`,
		};
	}
	return {
		ok: true,
		detail: `the core agent serves expvar on 127.0.0.1:${EXPVAR_PORT} as pid ${state.pid}`,
	};
}

const verifyFor = (agent, state, paths) =>
	agent.kind === "trace"
		? verifyTraceAgent(state, paths)
		: verifyCoreAgent(state, paths);

/** Per worker thread, set by handleApplication; a request that beats it, or a thread that never ran it, reads NOT_STARTED. */
let supervisor;

const NOT_STARTED = {
	receiverPort: RECEIVER_PORT,
	apiKey: process.env.DD_API_KEY ? "set" : "MISSING",
	processes: [],
	detail:
		`nothing has started on this thread. Check first that the node's harper-config.yaml carries ` +
		`\`${CONFIG_ENTRY}\`: Harper calls handleApplication only for a component the root config names, and ` +
		`a directory it loaded by scanning componentsRoot never reaches it. Otherwise this thread has not ` +
		`run startup yet, or it ran under a deploy validation load, which starts nothing`,
};

// Released Harper's Scope has no `processes` at all, so its absence is the whole version check and no config
// selects between the two. One binary per node comes from Harper's PID lock, not from this module.
const supervisesNatively = (scope) =>
	typeof scope?.processes?.start === "function";

const UNSUPERVISED =
	`this Harper's Scope has no processes.start, so there is nothing that can hold one agent per node. ` +
	`Every worker thread would spawn its own trace-agent and all but one would fail to bind ` +
	`127.0.0.1:${RECEIVER_PORT}, so nothing was started at all. Upgrade Harper to a build with the ` +
	`process sidecar API`;

// Never rejects: a throw out of handleApplication plants an ErrorResource at the component's root path,
// which is worse than running without telemetry and saying so.
async function startAgents(scope) {
	const status = {
		supervision: supervisesNatively(scope) ? "harper" : "unavailable",
		receiverPort: RECEIVER_PORT,
		apiKey: process.env.DD_API_KEY ? "set" : "MISSING",
		processes: [],
	};
	try {
		if (!supervisesNatively(scope)) {
			status.error = UNSUPERVISED;
			log.error(`Datadog supervisor: ${UNSUPERVISED}.`);
			return status;
		}
		if (!process.env.DD_API_KEY) {
			log.warn(
				"Datadog supervisor: DD_API_KEY is not set. Both agents will start and the trace-agent will " +
					"accept spans, but the intake rejects the payloads. Nothing will appear in Datadog."
			);
		}

		const runtime = prepareRuntime(import.meta.dirname);
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
		const fingerprint = [
			...Object.values(runtime.configFiles),
			process.env.DD_API_KEY ?? "",
			process.env.DD_SITE ?? "",
			process.env.DD_ENV ?? "",
			...binaries,
		];

		status.processes = await Promise.all(
			AGENTS.map((agent, index) =>
				startAgent(scope, agent, binaries[index], failures[index], {
					runtime,
					fingerprint,
				})
			)
		);
		// Harper forks one reaper per node and names it itself; a name here would be a second lock nothing sweeps.
		status.reaper = scope.processes.reaper;
	} catch (error) {
		status.error = error.message;
		log.error(`Datadog supervisor: startup failed: ${error.message}`);
	}
	return status;
}

// Started together rather than in sequence: start() awaits its own verify, and an awaited trace-agent holds
// the core agent behind it for as long as the receiver takes to bind.
function startAgent(scope, agent, command, failure, { runtime, fingerprint }) {
	const unstarted = (error) => ({
		name: agent.name,
		title: agent.title,
		kind: agent.kind,
		started: false,
		error,
	});
	if (!command) return Promise.resolve(unstarted(failure));
	return scope.processes
		.start({
			name: agent.name,
			title: agent.title,
			command,
			args: agent.args(runtime.paths),
			// On BOTH: start() writes after its own sweep, so naming them on one alone lets the other spawn
			// before the files exist.
			configFiles: runtime.configFiles,
			fingerprint,
			exitHint: agent.exitHint,
			verify: (state) => verifyFor(agent, state, runtime.paths),
		})
		.then((state) => Object.assign(state, { kind: agent.kind }))
		.then((state) => {
			if (state.verified !== true) {
				log.error(
					`Datadog supervisor: the ${agent.title} started but did not verify: ${state.verifyDetail ?? "no detail"}`
				);
			}
			return state;
		})
		.catch((error) => unstarted(describeSpawnFailure(error, command)));
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

/** GET /DatadogStatus/ - the plugin's one REST resource - reports what startup did. Everything it reports fails silently by default, which is why it gets an endpoint. */
export class DatadogStatus extends ResourceBase {
	static async get() {
		const status = supervisor ? await supervisor : NOT_STARTED;
		return {
			...status,
			// Which thread answered; every field above it is per-thread state.
			threadId,
			// Run these from a shell, not from inside this process: an endpoint reached through the tracing
			// pipeline is itself traced, and reading it changes what it reports.
			verify: {
				receiver: `curl -s 127.0.0.1:${status.receiverPort}/info`,
				coreAgent: `curl -s 127.0.0.1:${EXPVAR_PORT}/debug/vars`,
			},
		};
	}
}
