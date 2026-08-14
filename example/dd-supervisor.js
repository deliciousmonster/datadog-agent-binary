/**
 * Starts the Datadog core agent and the trace-agent as one-process-per-node singletons
 * from inside a Harper v5 component.
 *
 * resources.js must reach this file by a RELATIVE import. Harper substitutes its constrained
 * `child_process` only for modules its own loader compiles, and
 * `shouldUseApplicationLoader()` (security/jsLoader.ts) takes a relative specifier
 * unconditionally but takes an npm dependency only when that package depends on `harper`. A
 * supervisor published as an ordinary package gets the real `child_process`: no allowlist, no
 * mandatory `name`, no PID-file lock. It starts one agent per worker thread and looks like it
 * worked.
 *
 * The import must also stay ESM. Harper's `cjsRequire` forwards anything that is not a
 * `file:` URL to the real `require` without consulting `REPLACED_BUILTIN_MODULES`, so
 * `require("node:child_process")` in an app module gets the unconstrained builtin; only the
 * ESM path runs `checkAllowedModulePath()`.
 *
 * `assertSpawnInterception()` turns both assumptions into a startup check, because every
 * failure mode here is silent by default.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
// Bare specifier, so Harper loads this natively. Fine: nothing in it spawns. The spawn stays
// in this file, which Harper does instrument.
import { BinaryManager } from "@deliciousmonster/datadog-agent-binary";

/**
 * Harper seeds every application compartment with `logger`; entries land in hdb.log prefixed
 * with an ISO-8601 timestamp, which is what the multi_line rule in conf.d keys off. Outside
 * Harper the global is absent, and this module has to survive a native load long enough to
 * report that it was loaded natively.
 */
const log = typeof logger === "undefined" ? console : logger;

/** Default APM receiver port. dd-trace dials the same one with no configuration. */
const RECEIVER_PORT = Number(process.env.DD_APM_RECEIVER_PORT || 8126);

/** A command no machine has and no operator would allowlist. Only used to probe `spawn`. */
const PROBE_COMMAND = "harper-datadog-spawn-probe-must-not-exist";

/**
 * `name` is load-bearing twice over: Harper rejects a spawn without it, and it is the PID
 * lock filename (`<rootPath>/pids/<name>.pid`, taken with `openSync(..., "wx")`). A file lock
 * dedupes across worker threads and across processes sharing a root path, which is what "one
 * per node" means. Two names mean two independent locks, so each agent is a singleton without
 * blocking the other.
 */
const AGENTS = [
	{
		kind: "trace",
		name: "datadog-trace-agent",
		title: "trace-agent",
		resolve: (manager) => manager.ensureTraceAgentBinary(),
		// The trace-agent's `-c` is a FILE. Its help text says "path to directory containing
		// datadog.yaml", but that text is stale: upstream's `defaultConfigPath` is
		// `<install>/etc/datadog.yaml` (cmd/trace-agent/command). Handing it the directory
		// the core agent wants dies with "unable to load Datadog config file".
		args: (paths) => ["run", "-c", paths.configFile],
	},
	{
		kind: "core",
		name: "datadog-agent",
		title: "core agent",
		resolve: (manager) => manager.ensureBinary("core"),
		// The core agent's `-c`/`--cfgpath` really is a DIRECTORY, verified against the
		// shipped binary's `run --help`. The two binaries disagree about this flag.
		args: (paths) => ["run", "-c", paths.runtimeDir],
	},
];

/**
 * Prove that the `spawn` bound at the top of this file is Harper's, not Node's.
 *
 * Harper's `createSpawn` checks the allowlist before the `name` gate, so an unlistable
 * command throws `Command <x> is not allowed` synchronously, creating no PID file and no
 * process. Node's real `spawn` throws nothing here: it returns a ChildProcess with
 * `pid === undefined` and reports ENOENT asynchronously. That difference is the only cheap
 * way to tell the two apart, and without Harper's spawn there is no PID lock: every worker
 * thread starts its own pair, and every trace-agent after the first dies on EADDRINUSE
 * without printing anything.
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
		// Only Harper's wrapper throws synchronously from spawn() at all, so any other
		// synchronous throw still means interception, just not by the expected path.
		log.warn(
			`Datadog supervisor: spawn probe threw an unexpected error: ${error.message}. ` +
				`Treating interception as active, but verify the Harper version.`
		);
		return { intercepted: true, detail: error.message };
	}

	// No throw: this is Node's real spawn, and the ENOENT for PROBE_COMMAND is still in flight
	// as an 'error' event. Unhandled, it becomes an uncaught exception and kills this worker
	// thread.
	child.on("error", () => {});
	child.unref();

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
 * Directory holding datadog.yaml, conf.d, the auth token, the IPC certificate and the agent
 * logs. Nothing may land in the Datadog defaults: the deploy target runs as a non-root user
 * (`USER harperdb` on node:24-trixie) where /etc/datadog-agent, /opt/datadog-agent,
 * /var/log/datadog and /var/run/datadog are unwritable, and the failures are quiet (an
 * unwritable config directory makes the trace-agent hang 30 seconds, then die creating its
 * auth token).
 *
 * The component directory is deliberately not used: `harper deploy` replaces it, deleting the
 * run directory out from under a live agent.
 */
function resolveRuntimeDir() {
	if (process.env.DD_HARPER_RUNTIME_DIR)
		return process.env.DD_HARPER_RUNTIME_DIR;
	// ROOTPATH is set by the harper-pro image and points at the mounted volume, so the
	// Datadog tree sits next to Harper's own state and survives a restart.
	if (process.env.ROOTPATH) return join(process.env.ROOTPATH, "datadog");
	// Harper's default root path is in its boot properties file and is not derivable from
	// here. Fall back to a directory writable both in the container (HOME=/home/harperdb) and
	// in a developer shell.
	return join(homedir(), ".harper-datadog");
}

/**
 * Path to Harper's own log file, which the Datadog logs source tails.
 *
 * Never guessed from the home directory: Harper's root path lives in
 * `~/.harperdb/hdb_boot.properties`, which a component cannot read, and a guessed path that
 * does not exist produces a logs source that silently tails nothing. The operator pins it,
 * ROOTPATH supplies it, or log collection is skipped with an explanation.
 */
function resolveHarperLogPath() {
	if (process.env.DD_HARPER_LOG_PATH) return process.env.DD_HARPER_LOG_PATH;
	if (process.env.ROOTPATH) return join(process.env.ROOTPATH, "log", "hdb.log");
	return null;
}

/**
 * Numeric fingerprint of everything that should force replacement of a running agent.
 *
 * Harper compares this against line 2 of the PID file and, on a mismatch, SIGTERMs the
 * running process and re-acquires the lock. Without it, a process left over from a previous
 * boot is adopted forever, which is a real hazard here: the PID files sit on a persistent
 * volume and outlive the container that created them.
 *
 * It must be a NUMBER. Harper reads the recorded value with `parseInt()` and compares with
 * `!==`, so a string version never equals its own recorded value and every thread would kill
 * and respawn the agent, forever.
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
 * Every worker thread rewrites the same config files at start, and a running agent rereads
 * them. A thread killed mid-write (harper dev restarts them on every save) would otherwise
 * leave a torn YAML for the agent to choke on. rename() within one directory is atomic, so
 * the agent sees the old file or the new one, never half of each. The temp name carries pid
 * and threadId because sibling threads write these files concurrently.
 */
function writeFileAtomic(target, contents) {
	const temp = `${target}.${process.pid}.${threadId}.tmp`;
	writeFileSync(temp, contents, "utf-8");
	renameSync(temp, target);
}

/**
 * The datadog.yaml both binaries read. Rewritten on every start, so it is a projection of
 * this file rather than something to hand-edit. DD_API_KEY and DD_SITE are inherited from the
 * spawning environment instead, so no secret lands in the runtime tree.
 */
function renderDatadogYaml(paths) {
	return [
		"# GENERATED by dd-supervisor.js on every Harper worker start. Edits are overwritten.",
		"#",
		"# Every path is relocated off the Datadog defaults, which are unwritable for the",
		"# non-root user the deploy target runs as.",
		"#",
		"# api_key and site are absent by design: they come from DD_API_KEY / DD_SITE in the",
		"# environment, which keeps the key out of this file.",
		"",
		`confd_path: ${yamlString(paths.confd)}`,
		`run_path: ${yamlString(paths.run)}`,
		`auth_token_file_path: ${yamlString(paths.authToken)}`,
		`ipc_cert_file_path: ${yamlString(paths.ipcCert)}`,
		"",
		"# File logging is off AND both log paths are relocated. The binaries do not honour",
		"# disable_file_logging identically, so one that ignores it still writes somewhere it",
		"# may write, instead of one permission-denied line per log line into Harper's log.",
		"disable_file_logging: true",
		"log_to_console: true",
		`log_file: ${yamlString(paths.coreLog)}`,
		"",
		"# Off by default in the agent. The source itself is in conf.d.",
		"logs_enabled: true",
		"",
		"# Loopback only. Nothing here should be reachable from outside the container.",
		'bind_host: "127.0.0.1"',
		"",
		"apm_config:",
		"  enabled: true",
		`  receiver_port: ${RECEIVER_PORT}`,
		"  # On, this binds 0.0.0.0 and accepts spans from anything that reaches the container.",
		"  apm_non_local_traffic: false",
		`  log_file: ${yamlString(paths.traceLog)}`,
		"",
	].join("\n");
}

/**
 * Render the shipped logs source into the runtime conf.d. The template is version-controlled
 * with the component, but its `path` is absolute and machine-specific, so it carries
 * placeholders substituted here. See conf.d/harperdb.d/conf.yaml for the multi_line rule.
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
 * PID lock, calls the real spawn, then evaluates `childProcess.pid.toString()` to write the
 * file. For a missing binary `pid` is `undefined`, so that throws a TypeError out of the
 * spawn call: after the 0-byte lock file exists, before the 'exit' handler that would clean
 * it up is attached.
 */
function preflightBinary(title, binaryPath) {
	// Harper's allowlist test is `ALLOWED_COMMANDS.has(command.split(" ")[0])`, so a path
	// containing a space can never be allowlisted by any config. Failing on it explicitly,
	// because otherwise the error reads as a plain "not allowed" and sends people to edit a
	// config that cannot help them.
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
			// Piped, not inherited: agent output has to reach Harper's log file, which is
			// what the conf.d source tails.
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
	state.started = true;

	// Attached before anything else touches the child, and before the early return below.
	// Harper attaches only its own 'exit' listener, and an unhandled 'error' on a
	// ChildProcess becomes an uncaught exception that takes the worker thread with it. The
	// event is asynchronous, so returning from here without this listener is a crash waiting
	// on the next tick.
	child.on("error", (error) => {
		log.error(
			`Datadog supervisor: the ${descriptor.title} failed to execute: ${error.message}`
		);
	});

	// Every loser of the PID-file race gets an ExistingProcessWrapper: an EventEmitter with
	// pid, kill(), unref() and an 'exit' event. Detected by the absence of `spawnargs`,
	// which every real ChildProcess carries and the wrapper does not; stdout is not a safe
	// tell, because a winner spawned with its stdio ignored also has a null stdout.
	state.adopted = !Array.isArray(child.spawnargs);
	if (state.adopted) {
		log.info(
			`Datadog supervisor: the ${descriptor.title} is already running on this node ` +
				`(pid ${child.pid}); this thread joined it instead of starting a second one.`
		);
		// The wrapper polls the process once a second on a setInterval it never unref'd,
		// pinning the worker's event loop. unref() is what clears that interval.
		child.unref();
		return state;
	}

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
	// does not fail fast: it hangs for 30 seconds, then dies on "error while creating or
	// fetching auth token", which reads like a network problem.
	accessSync(runtimeDir, constants.W_OK);

	// The trace-agent is fatal without a config file that EXISTS; the contents may be empty.
	const datadogYaml = renderDatadogYaml(paths);
	writeFileAtomic(paths.configFile, datadogYaml);

	const service = process.env.DD_SERVICE || "harper";
	const logPath = resolveHarperLogPath();
	let logsYaml = "";
	if (logPath) {
		logsYaml = renderLogsConfig(componentDir, logPath, service);
		writeFileAtomic(join(paths.confd, "harperdb.d", "conf.yaml"), logsYaml);
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
 * Harper's PID lock collapses the surviving threads to one process per node.
 *
 * Never rejects. A supervisor that throws at component load takes the whole application with
 * it, which is worse than an application running without telemetry and saying so.
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

		// Without Harper's spawn in this module there is no PID lock, so launching would
		// start one agent pair per worker thread; all but one trace-agent then dies on
		// EADDRINUSE. assertSpawnInterception() has already logged the causes and the fix,
		// and /DatadogStatus/ reports the empty agents list.
		if (!status.interception.intercepted) return status;

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
			// Resolve both paths up front. The version covers the pair, and each path is then
			// handed to the spawn that uses it, so the fingerprint can never describe a
			// different binary from the one started. A resolution failure becomes an empty
			// string and is reported per-agent by launchOne().
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
			// The credentials ride in the inherited environment, never in the config files,
			// so they are invisible to the fingerprint unless folded in here; without them a
			// rotated DD_API_KEY leaves the running agents posting the old key forever.
			const version = configVersion(
				runtime.fingerprint,
				process.env.DD_API_KEY ?? "",
				process.env.DD_SITE ?? "",
				process.env.DD_ENV ?? "",
				...binaries
			);
			status.version = version;

			// In order, trace-agent first: it owns the socket dd-trace is already trying to
			// reach.
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
