/**
 * Starts the Datadog core agent and the trace-agent as one-process-per-node singletons
 * from inside a Harper v5 component.
 *
 * WHY THIS FILE IS IMPORTED RELATIVELY FROM resources.js
 * ------------------------------------------------------
 * Harper only substitutes its constrained `child_process` for modules its own loader
 * compiles. `security/jsLoader.ts::shouldUseApplicationLoader()` decides that:
 *
 *     if (specifier.startsWith('.')) return true;           // relative -> always Harper's loader
 *     ...
 *     if (resolvedUrl.includes('/node_modules/'))
 *         return packageDependsOnHarper(resolvedUrl);       // npm dep -> only if it needs Harper
 *     return false;
 *
 * So a supervisor published as an npm package that does not itself depend on `harper` is
 * loaded natively and receives the REAL `child_process`: no allowlist, no mandatory `name`,
 * and critically NO PID-file lock. It would start one agent per worker thread and look like
 * it worked. Reaching this module by a relative specifier from the component's own entry is
 * what keeps the singleton real.
 *
 * The import below must also stay ESM. Harper's CJS shim (`cjsRequire` in jsLoader) forwards
 * anything that is not a `file:` URL straight to the real `require`, without consulting
 * `REPLACED_BUILTIN_MODULES`, so `require("node:child_process")` inside an app module gets
 * the unconstrained builtin. Only the ESM path runs `checkAllowedModulePath()`, which is what
 * returns the constrained module.
 *
 * `assertSpawnInterception()` below turns both of those from assumptions into a startup check,
 * because every failure mode here is silent by default.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Resolves the binaries the platform package installed. This is a bare specifier, so Harper
// loads it natively -- fine, because nothing here spawns anything. The spawn stays in this
// file, which Harper does instrument.
import { BinaryManager } from "@deliciousmonster/datadog-agent-binary";

/**
 * `logger` is a Harper component global: jsLoader seeds every application compartment with it
 * (`getGlobalObject()`), and its entries are written to hdb.log prefixed with an ISO-8601
 * timestamp, which is exactly what the multi_line rule in conf.d keys off. Outside Harper the
 * global does not exist, so fall back to console rather than throwing a ReferenceError -- this
 * module has to survive being loaded natively long enough to report that it was.
 */
const log = typeof logger === "undefined" ? console : logger;

/** Default APM receiver port. dd-trace dials the same one with no configuration. */
const RECEIVER_PORT = Number(process.env.DD_APM_RECEIVER_PORT || 8126);

/**
 * A command that cannot exist on any machine and cannot plausibly appear in an operator's
 * `applications.allowedSpawnCommands`. Used only to observe which `spawn` we are holding.
 */
const PROBE_COMMAND = "harper-datadog-spawn-probe-must-not-exist";

/**
 * The two processes, and everything that differs between them.
 *
 * `name` is load-bearing twice over: Harper rejects a spawn without it, and it is the PID
 * lock filename (`<rootPath>/pids/<name>.pid`, taken with `openSync(..., "wx")`). Because the
 * lock is a file rather than in-process state it dedupes across worker threads AND across
 * processes sharing a root path, which is the definition of "one per node". Two distinct
 * names mean two independent locks, so the core agent and the trace-agent are each a
 * singleton without either one blocking the other.
 */
const AGENTS = [
	{
		kind: "trace",
		name: "datadog-trace-agent",
		title: "trace-agent",
		resolve: (manager) => manager.ensureTraceAgentBinary(),
		// The trace-agent's `-c`/`--config` is a FILE path. Its help text reads "path to
		// directory containing datadog.yaml", but that text is stale: upstream's
		// `defaultConfigPath` is `<install>/etc/datadog.yaml` on Unix and
		// `c:\programdata\datadog\datadog.yaml` on Windows (cmd/trace-agent/command).
		// Handing it the directory the core agent wants is the easiest way to get a
		// "unable to load Datadog config file" death that reads like a missing file.
		args: (paths) => ["run", "-c", paths.configFile],
	},
	{
		kind: "core",
		name: "datadog-agent",
		title: "core agent",
		resolve: (manager) => manager.ensureBinary("core"),
		// The core agent's `-c`/`--cfgpath` really is a DIRECTORY: verified against the
		// shipped binary, `datadog-agent run --help` -> "path to directory containing
		// datadog.yaml". The two binaries genuinely disagree about this flag.
		args: (paths) => ["run", "-c", paths.runtimeDir],
	},
];

/**
 * Prove that the `spawn` bound at the top of this file is Harper's, not Node's.
 *
 * Harper's `createSpawn` checks the allowlist first, before the `name` gate, so an
 * unlistable command throws `Command <x> is not allowed` synchronously and creates no PID
 * file and no process. Node's real `spawn` throws nothing here: it returns a ChildProcess
 * with `pid === undefined` and reports ENOENT asynchronously.
 *
 * That difference is the only cheap way to tell the two apart, and getting it wrong is the
 * entire bug class this component exists to demonstrate: without Harper's spawn there is no
 * PID lock, so every worker thread starts its own pair of agents and the second trace-agent
 * onward dies on EADDRINUSE while the first keeps the port. Nothing in that sequence prints
 * an error by default.
 *
 * @returns {{intercepted: boolean, detail: string}}
 */
export function assertSpawnInterception() {
	let child;
	try {
		child = spawn(PROBE_COMMAND, [], { name: "dd-spawn-probe" });
	} catch (error) {
		if (/is not allowed/.test(error.message)) {
			log.info(
				`Datadog supervisor: Harper's constrained child_process is active (probe rejected ` +
					`with "${error.message}"). Agent spawns are deduped by the PID-file lock under ` +
					`<rootPath>/pids/, so this node runs exactly one core agent and one trace-agent ` +
					`no matter how many worker threads load this component.`
			);
			return { intercepted: true, detail: error.message };
		}
		// Some other synchronous throw. Only Harper's wrapper throws synchronously from
		// spawn() at all, so this still indicates interception, just not via the path
		// expected. Report it rather than swallowing it.
		log.warn(
			`Datadog supervisor: spawn probe threw an unexpected error: ${error.message}. ` +
				`Treating interception as active, but verify the Harper version.`
		);
		return { intercepted: true, detail: error.message };
	}

	// No throw. We are holding Node's real spawn, and the ENOENT for PROBE_COMMAND is still
	// in flight as an 'error' event. Node promotes an unhandled 'error' on a ChildProcess to
	// an uncaught exception, which would kill this worker thread, so absorb it.
	child?.on?.("error", () => {});
	child?.unref?.();

	log.error(
		`Datadog supervisor: HARPER'S SPAWN INTERCEPTION IS NOT ACTIVE. Spawning ` +
			`"${PROBE_COMMAND}" was permitted, which means this module received Node's real ` +
			`child_process. There is no PID-file singleton: every worker thread will start its ` +
			`own core agent and its own trace-agent, all but one trace-agent will fail to bind ` +
			`127.0.0.1:${RECEIVER_PORT}, and none of that is reported anywhere. Causes, in order ` +
			`of likelihood: this file was not reached by a RELATIVE import from the component ` +
			`entry (a bare npm specifier is loaded natively unless the package depends on ` +
			`harper); child_process was pulled in with require() instead of import (Harper's ` +
			`CJS require does not apply the substitution); or applications.moduleLoader is set ` +
			`to "native", which disables the application loader entirely.`
	);
	return {
		intercepted: false,
		detail: "spawn of a bogus command was permitted",
	};
}

/**
 * Directory that holds datadog.yaml, conf.d, the auth token, the IPC certificate, and the
 * agent log files.
 *
 * Nothing may land in the Datadog defaults. The deploy target runs as a non-root user
 * (`USER harperdb` on node:24-trixie), where /etc/datadog-agent, /opt/datadog-agent,
 * /var/log/datadog and /var/run/datadog are all unwritable, and the resulting failures are
 * mostly quiet: an unwritable config directory makes the trace-agent hang for 30 seconds and
 * then die trying to create its auth token.
 *
 * The component directory is deliberately NOT used: `harper deploy` replaces it, which would
 * delete the run directory out from under a live agent.
 */
function resolveRuntimeDir() {
	if (process.env.DD_HARPER_RUNTIME_DIR)
		return process.env.DD_HARPER_RUNTIME_DIR;
	// ROOTPATH is set explicitly by the harper-pro image and points at the mounted volume,
	// so this keeps the Datadog tree next to Harper's own state and it survives a restart.
	if (process.env.ROOTPATH) return join(process.env.ROOTPATH, "datadog");
	// Harper's default root path is recorded in its boot properties file and is not
	// derivable from here, so fall back to the one directory that is writable in both the
	// container (HOME=/home/harperdb) and a developer shell.
	return join(homedir(), ".harper-datadog");
}

/**
 * Path to Harper's own log file, which the Datadog logs source tails.
 *
 * Harper's default root path lives in `~/.harperdb/hdb_boot.properties` and is not readable
 * from a component, so this is never guessed from the home directory: a guessed path that
 * does not exist produces a logs source that silently tails nothing. Either the operator
 * pins it, or ROOTPATH tells us, or log collection is skipped with an explanation.
 */
function resolveHarperLogPath() {
	if (process.env.DD_HARPER_LOG_PATH) return process.env.DD_HARPER_LOG_PATH;
	if (process.env.ROOTPATH) return join(process.env.ROOTPATH, "log", "hdb.log");
	return null;
}

/**
 * Numeric fingerprint of everything that should force a replacement of a running agent.
 *
 * Harper compares this against line 2 of the PID file and, on a mismatch, SIGTERMs the
 * running process and re-acquires the lock. That is the supported way to replace an agent
 * whose binary or configuration changed, instead of adopting a process left over from a
 * previous boot forever -- a real hazard here, because the PID files sit on a persistent
 * volume and survive the container that created them.
 *
 * It must be a NUMBER. Harper reads the recorded value with `parseInt()` and compares with
 * `!==`, so a string version never equals its own recorded value: every thread would decide
 * the running agent is stale, kill it, and respawn, forever.
 */
function configVersion(...parts) {
	// >>> 1 keeps it inside 2^31 so it round-trips through parseInt() unchanged.
	return (
		createHash("sha256").update(parts.join("\0")).digest().readUInt32BE(0) >>> 1
	);
}

/** YAML-safe scalar. Double-quoted form also survives Windows drive letters. */
function yamlString(value) {
	return JSON.stringify(String(value));
}

/**
 * The datadog.yaml both binaries read.
 *
 * It is rewritten on every start, so it is a projection of this file rather than something to
 * hand-edit. Secrets are not written here: DD_API_KEY and DD_SITE are inherited from the
 * spawning process's environment so they never land on disk in the component's runtime tree.
 */
function renderDatadogYaml(paths) {
	return [
		"# GENERATED by dd-supervisor.js on every Harper worker start. Edits are overwritten.",
		"#",
		"# Every path below is relocated off the Datadog defaults because the deploy target",
		"# runs as a non-root user, where /etc/datadog-agent, /opt/datadog-agent,",
		"# /var/log/datadog and /var/run/datadog are all unwritable.",
		"#",
		"# api_key and site are intentionally absent: they come from DD_API_KEY / DD_SITE in",
		"# the environment, which keeps the key out of this file.",
		"",
		`confd_path: ${yamlString(paths.confd)}`,
		`run_path: ${yamlString(paths.run)}`,
		`auth_token_file_path: ${yamlString(paths.authToken)}`,
		`ipc_cert_file_path: ${yamlString(paths.ipcCert)}`,
		"",
		"# File logging is disabled AND both log paths are relocated. Either alone would do if",
		"# both binaries honoured disable_file_logging identically; doing both means an agent",
		"# that ignores the flag still writes somewhere it is allowed to write, instead of",
		"# emitting one permission-denied line per log line into Harper's own log.",
		"disable_file_logging: true",
		"log_to_console: true",
		`log_file: ${yamlString(paths.coreLog)}`,
		"",
		"# Log collection is off by default in the agent; the source itself is in conf.d.",
		"logs_enabled: true",
		"",
		"# Loopback only. Nothing here should be reachable from outside the container.",
		'bind_host: "127.0.0.1"',
		"",
		"apm_config:",
		"  enabled: true",
		`  receiver_port: ${RECEIVER_PORT}`,
		"  # Leave the receiver on the loopback interface. Turning this on would bind 0.0.0.0",
		"  # and accept spans from anything that can reach the container.",
		"  apm_non_local_traffic: false",
		`  log_file: ${yamlString(paths.traceLog)}`,
		"",
	].join("\n");
}

/**
 * Render the shipped logs source into the runtime conf.d.
 *
 * The template lives in the component (reviewable, version-controlled) but its `path` has to
 * be absolute and machine-specific, so it carries placeholders that are substituted here.
 * See conf.d/harperdb.d/conf.yaml for why the multi_line rule is there.
 */
function renderLogsConfig(componentDir, logPath, service) {
	const template = readFileSync(
		join(componentDir, "conf.d", "harperdb.d", "conf.yaml"),
		"utf-8"
	);
	return template
		.replaceAll("__HDB_LOG_PATH__", logPath)
		.replaceAll("__DD_SERVICE__", service);
}

/**
 * Everything that has to be true before `spawn` is called.
 *
 * Spawning a missing binary under Harper is worse than not spawning at all. Harper takes the
 * PID lock first, calls the real spawn, and then evaluates `childProcess.pid.toString()` to
 * write the file. For a missing binary `pid` is `undefined`, so that line throws a TypeError
 * out of the spawn call itself -- after the 0-byte lock file already exists, and before any
 * 'exit' handler that would clean it up is attached.
 */
function preflightBinary(title, binaryPath) {
	// Harper's allowlist test is `ALLOWED_COMMANDS.has(command.split(" ")[0])`. Only the
	// fragment before the first space is ever compared, so a path containing a space can
	// never be allowlisted, by any config. It is worth failing on this explicitly because
	// the resulting error otherwise reads as a plain "not allowed" and sends people to edit
	// a config that cannot help them.
	if (binaryPath.includes(" ")) {
		throw new Error(
			`The ${title} binary path contains a space: ${binaryPath}. Harper matches the ` +
				`allowlist with command.split(" ")[0], so no applications.allowedSpawnCommands ` +
				`entry can ever match this path. Install the component somewhere without spaces.`
		);
	}
	if (!existsSync(binaryPath)) {
		throw new Error(
			`The ${title} binary is missing at ${binaryPath}. Not spawning it: Harper would ` +
				`create the PID lock file, get a child with pid === undefined, and throw a ` +
				`TypeError while writing that PID.`
		);
	}
	accessSync(binaryPath, constants.X_OK);
}

/** Forward an agent's stdout/stderr into Harper's log, one line per entry. */
function pipeToHarperLog(stream, title, level) {
	let pending = "";
	stream.setEncoding("utf-8");
	stream.on("data", (chunk) => {
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim()) log[level](`[${title}] ${line}`);
		}
	});
}

/** Preflight and start one already-resolved agent. Never throws; returns what happened. */
function launchOne(descriptor, binaryPath, paths, version) {
	const state = {
		kind: descriptor.kind,
		name: descriptor.name,
		started: false,
		binaryPath,
	};

	try {
		if (!binaryPath) throw new Error("its path could not be resolved");
		preflightBinary(descriptor.title, binaryPath);
	} catch (error) {
		state.error = error.message;
		log.error(
			`Datadog supervisor: cannot start the ${descriptor.title}: ${error.message}`
		);
		return state;
	}

	const args = descriptor.args(paths);
	let child;
	try {
		child = spawn(binaryPath, args, {
			// Required by Harper, and the PID lock filename.
			name: descriptor.name,
			// See configVersion(): a number, never a string.
			version,
			// Piped rather than inherited, for two reasons. Agent output reaches Harper's
			// log file, which is what the conf.d source tails. And `!child.stdout` stays a
			// sound test for Harper's ExistingProcessWrapper below: with stdio "inherit" a
			// real ChildProcess also has a null stdout, and the test would report every
			// thread as a loser of the race.
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
	} catch (error) {
		state.error = error.message;
		log.error(
			`Datadog supervisor: Harper refused to spawn the ${descriptor.title}: ` +
				`${error.message}. If this says "is not allowed", add this exact absolute path ` +
				`to applications.allowedSpawnCommands and restart Harper (the allowlist is read ` +
				`once at module load, so editing it without a restart changes nothing): ` +
				`${binaryPath}`
		);
		return state;
	}

	state.pid = child.pid;

	// Attached before anything else looks at the child, and before the early return below.
	// Harper attaches only an 'exit' listener of its own, and Node promotes an unhandled
	// 'error' on a ChildProcess to an uncaught exception, which takes the worker thread with
	// it. The event is asynchronous, so any code path that returns from here without a
	// listener registered is a crash waiting on the next tick.
	child.on("error", (error) => {
		log.error(
			`Datadog supervisor: the ${descriptor.title} failed to execute: ${error.message}`
		);
	});

	// Every loser of the PID-file race gets an ExistingProcessWrapper: an EventEmitter with
	// pid, kill(), unref() and an 'exit' event, and no stdio at all. Touching child.stdout
	// on those threads is a TypeError.
	if (!child.stdout) {
		state.started = true;
		state.adopted = true;
		log.info(
			`Datadog supervisor: the ${descriptor.title} is already running on this node ` +
				`(pid ${child.pid}); this thread joined it instead of starting a second one.`
		);
		// The wrapper polls the process once a second on a setInterval it never unref'd, so
		// without this the worker's event loop is pinned and the thread will not go idle or
		// shut down cleanly. unref() is what clears that interval.
		child.unref();
		return state;
	}

	state.started = true;
	state.adopted = false;
	log.info(
		`Datadog supervisor: started the ${descriptor.title} (pid ${child.pid}): ` +
			`${binaryPath} ${args.join(" ")}`
	);

	pipeToHarperLog(child.stdout, descriptor.title, "info");
	pipeToHarperLog(child.stderr, descriptor.title, "warn");

	child.on("exit", (code, signal) => {
		if (signal) {
			log.warn(
				`Datadog supervisor: the ${descriptor.title} was terminated by ${signal}.`
			);
			return;
		}
		if (code === 0) {
			log.info(`Datadog supervisor: the ${descriptor.title} exited cleanly.`);
			return;
		}
		log.error(
			`Datadog supervisor: the ${descriptor.title} exited with code ${code}. Harper has ` +
				`removed its PID file, so the next worker to load this component will try again. ` +
				`For the trace-agent, an immediate non-zero exit usually means something else ` +
				`already holds 127.0.0.1:${RECEIVER_PORT}.`
		);
	});

	return state;
}

/** Create the runtime tree and write both config files. */
function prepareRuntime(componentDir) {
	const runtimeDir = resolveRuntimeDir();
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
	mkdirSync(join(paths.confd, "harperdb.d"), { recursive: true });

	// The trace-agent writes its auth token beside the config file. Without write access it
	// does not fail fast: it hangs for 30 seconds and then dies on "error while creating or
	// fetching auth token", which reads like a network problem.
	accessSync(runtimeDir, constants.W_OK);

	// The trace-agent is fatal without a config file that EXISTS. Its contents can be empty;
	// existence is the requirement. Writing it here is also what makes every relocation above
	// take effect for both binaries at once.
	const datadogYaml = renderDatadogYaml(paths);
	writeFileSync(paths.configFile, datadogYaml, "utf-8");

	const service = process.env.DD_SERVICE || "harper";
	const logPath = resolveHarperLogPath();
	let logsYaml = "";
	if (logPath) {
		logsYaml = renderLogsConfig(componentDir, logPath, service);
		writeFileSync(
			join(paths.confd, "harperdb.d", "conf.yaml"),
			logsYaml,
			"utf-8"
		);
		if (!existsSync(logPath)) {
			log.warn(
				`Datadog supervisor: Harper's log file ${logPath} does not exist yet. The agent ` +
					`will tail it once it appears, but if it never does, logging.file is off or ` +
					`logging.path points somewhere else.`
			);
		}
	} else {
		log.warn(
			`Datadog supervisor: no log source was written, because Harper's log path could ` +
				`not be determined. It is recorded in Harper's boot properties, not anywhere a ` +
				`component can read. Set DD_HARPER_LOG_PATH (or ROOTPATH) to enable log ` +
				`collection. Traces are unaffected.`
		);
	}

	return { paths, logPath, service, fingerprint: datadogYaml + logsYaml };
}

let started;

/**
 * Start both agents. Safe to call repeatedly: the work happens once per worker thread, and
 * Harper's PID lock collapses the surviving threads down to one process per node.
 *
 * Never rejects. A supervisor that throws at component load takes the whole application down
 * with it, which is a strictly worse outcome than an application running without telemetry
 * and saying so.
 *
 * @param {string} componentDir absolute path to this component (import.meta.dirname).
 */
export function startDatadogAgents(componentDir) {
	started ??= (async () => {
		const status = {
			interception: assertSpawnInterception(),
			receiverPort: RECEIVER_PORT,
			apiKey: process.env.DD_API_KEY ? "set" : "MISSING",
			agents: [],
		};

		if (!process.env.DD_API_KEY) {
			// The receiver validates nothing at accept time: spans are taken off the socket,
			// batched, and dropped when the intake rejects them. dd-trace sees a successful
			// flush either way, so an empty APM page is the only symptom.
			log.warn(
				"Datadog supervisor: DD_API_KEY is not set. Both agents will start and the " +
					"trace-agent will accept spans from dd-trace, but the intake rejects the " +
					"payloads and they are discarded. Nothing will appear in Datadog."
			);
		}

		try {
			const runtime = prepareRuntime(componentDir);
			status.runtimeDir = runtime.paths.runtimeDir;
			status.configFile = runtime.paths.configFile;
			status.harperLogPath = runtime.logPath;
			status.service = runtime.service;

			const manager = new BinaryManager();
			// Resolve both paths up front, once. The version has to cover the pair, and each
			// path is then handed to the spawn that uses it, so the fingerprint can never
			// describe a different binary from the one actually started. A resolution failure
			// becomes an empty string here and is reported per-agent by launchOne().
			const binaries = await Promise.all(
				AGENTS.map((descriptor) =>
					descriptor.resolve(manager).catch((error) => {
						log.error(
							`Datadog supervisor: could not resolve the ${descriptor.title} ` +
								`binary: ${error.message}`
						);
						return "";
					})
				)
			);
			const version = configVersion(runtime.fingerprint, ...binaries);
			status.version = version;

			// In order, and the trace-agent first: it owns the socket dd-trace is already
			// trying to reach, and it keeps the startup log readable.
			for (const [index, descriptor] of AGENTS.entries()) {
				status.agents.push(
					launchOne(descriptor, binaries[index], runtime.paths, version)
				);
			}
		} catch (error) {
			status.error = error.message;
			log.error(`Datadog supervisor: startup failed: ${error.message}`);
		}

		return status;
	})();

	return started;
}
