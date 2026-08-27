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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { threadId } from 'node:worker_threads';
// Bare specifier, so Harper loads this natively. Fine: nothing in it spawns. The spawn stays
// in this file, which Harper does instrument.
import { BinaryManager } from '@deliciousmonster/datadog-agent-binary';

/** Must stay the specifier imported above; resolvePackageConfd() looks the package up by it. */
const PACKAGE_NAME = '@deliciousmonster/datadog-agent-binary';

/**
 * Harper seeds every application compartment with `logger`; entries land in hdb.log prefixed
 * with an ISO-8601 timestamp, which is what the multi_line rule in conf.d keys off. Outside
 * Harper the global is absent, and this module has to survive a native load long enough to
 * report that it was loaded natively.
 */
const log = typeof logger === 'undefined' ? console : logger;

/** `apm_config.receiver_port` default. dd-trace dials the same one with no configuration. */
const DEFAULT_RECEIVER_PORT = 8126;

/**
 * The port to write into `apm_config.receiver_port` and to probe afterwards.
 *
 * Parsed rather than coerced. `Number("8126 ")` is fine but `Number("banana")` is NaN,
 * and NaN reaches the generated datadog.yaml as `receiver_port: NaN`, which the agent
 * cannot read. 0 is kept as itself: upstream reads it as "serve no HTTP receiver", so
 * rewriting it to 8126 would contradict the operator and make every probe below
 * interrogate a port nothing was told to bind.
 */
function resolveReceiverPort() {
	const raw = process.env.DD_APM_RECEIVER_PORT;
	if (!raw) return DEFAULT_RECEIVER_PORT;
	// The raw string, not the parsed value: parseInt("0abc") is also 0, and that is a
	// typo rather than a request to turn the receiver off.
	if (raw.trim() === '0') return 0;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
	log.warn(
		`Datadog supervisor: DD_APM_RECEIVER_PORT="${raw}" is not a port in 1-65535. ` +
			`Using ${DEFAULT_RECEIVER_PORT}, the port dd-trace dials, but the agents read the ` +
			`same variable and will not resolve it the same way. Fix or unset it.`
	);
	return DEFAULT_RECEIVER_PORT;
}

const RECEIVER_PORT = resolveReceiverPort();

/** `apm_config.debug.port` default, from upstream's own BindEnvAndSetDefault. */
const DEFAULT_DEBUG_PORT = 5012;

/**
 * The port the trace-agent serves expvar on. Written into the generated config rather than
 * left to the upstream default, because readDeliverySignal() has to reach it: a probe aimed
 * at an assumed port and an agent that moved would report a healthy node as unreachable.
 * DD_APM_DEBUG_PORT is the agent's own variable, so the two cannot be made to disagree.
 */
function resolveDebugPort() {
	const raw = process.env.DD_APM_DEBUG_PORT;
	if (!raw) return DEFAULT_DEBUG_PORT;
	// Upstream reads 0 as "serve no debug endpoint" (debug_server.go), which is a legitimate
	// choice and not something to override.
	if (raw.trim() === '0') return 0;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
	log.warn(
		`Datadog supervisor: DD_APM_DEBUG_PORT="${raw}" is not a port in 1-65535. Using ` +
			`${DEFAULT_DEBUG_PORT}. The delivery signal on /DatadogStatus/ reads that port.`
	);
	return DEFAULT_DEBUG_PORT;
}

const DEBUG_PORT = resolveDebugPort();

/**
 * How long the trace-agent gets to answer /info before the supervisor reports the
 * receiver as absent. Generous on purpose: a deadline that fires during a slow cold start
 * would describe a working node as broken, and this number is only ever read by a human.
 */
const RECEIVER_BIND_TIMEOUT_MS = 30_000;

const RECEIVER_POLL_INTERVAL_MS = 250;

/** A command no machine has and no operator would allowlist. Only used to probe `spawn`. */
const PROBE_COMMAND = 'harper-datadog-spawn-probe-must-not-exist';

/**
 * `name` is load-bearing twice over: Harper rejects a spawn without it, and it is the PID
 * lock filename (`<rootPath>/pids/<name>.pid`, taken with `openSync(..., "wx")`). A file lock
 * dedupes across worker threads and across processes sharing a root path, which is what "one
 * per node" means. Two names mean two independent locks, so each agent is a singleton without
 * blocking the other.
 */
const AGENTS = [
	{
		kind: 'trace',
		name: 'datadog-trace-agent',
		title: 'trace-agent',
		resolve: (manager) => manager.ensureTraceAgentBinary(),
		// The trace-agent's `-c` is a FILE. Its help text says "path to directory containing
		// datadog.yaml", but that text is stale: upstream's `defaultConfigPath` is
		// `<install>/etc/datadog.yaml` (cmd/trace-agent/command). Handing it the directory
		// the core agent wants dies with "unable to load Datadog config file".
		args: (paths) => ['run', '-c', paths.configFile],
	},
	{
		kind: 'core',
		name: 'datadog-agent',
		title: 'core agent',
		resolve: (manager) => manager.ensureBinary('core'),
		// The core agent's `-c`/`--cfgpath` really is a DIRECTORY, verified against the
		// shipped binary's `run --help`. The two binaries disagree about this flag.
		args: (paths) => ['run', '-c', paths.runtimeDir],
	},
];

/**
 * The process that stops the agents when the node does. Its own `name`, so its own PID lock:
 * one per node, deduped across worker threads exactly like an agent, and outliving the thread
 * that won the race for it. See dd-reaper.js for why this is a process and not a callback.
 */
const REAPER = {
	name: 'datadog-agent-reaper',
	title: 'agent reaper',
	script: 'dd-reaper.js',
};

/**
 * How long the reaper waits, after Harper's main process disappears, for a replacement to
 * write a new `hdb.pid` before it stops the agents.
 *
 * `harper restart` forks a fresh main process and exits the old one, so the parent dies on a
 * path where the agents should be kept. Long enough to cover that fork (`bin/run.js` writes
 * the file early, before component load), short enough that `harper stop` frees 8126 while an
 * operator is still watching.
 */
const REAPER_RESTART_GRACE_MS = 8000;

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
		child = spawn(PROBE_COMMAND, [], { name: 'dd-spawn-probe' });
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
	child.on('error', () => {});
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
		detail: 'spawn of a bogus command was permitted',
	};
}

/**
 * Harper's root path, read the way Harper reads it: the boot properties file names the
 * settings file, and the settings file carries `rootPath`.
 *
 * `node:fs` is genuinely available here. Harper's application loader substitutes exactly one
 * builtin, `child_process` (`REPLACED_BUILTIN_MODULES`, security/jsLoader.ts), so a component
 * reads both files the same way any Node module would.
 *
 * Returns null for anything unexpected, and never throws. This runs at component load inside
 * a database node, so an absent boot file, a `settings_path` naming a file that is gone, or a
 * line in a shape neither Harper nor this function expects has to fall through to the caller's
 * next candidate rather than take the node down with it.
 *
 * @returns {string | null}
 */
function readHarperRootPath() {
	try {
		const boot = readFileSync(join(homedir(), '.harperdb', 'hdb_boot_properties.file'), 'utf-8');
		// Java-style properties, not YAML, and Harper indents every line after the first, so
		// the leading whitespace class is load-bearing. Same shape Harper's own installer
		// matches with (utility/install/installer.js).
		const settingsPath = boot.match(/^[ \t]*settings_path[ \t]*=[ \t]*(.+?)[ \t]*$/m)?.[1];
		if (!settingsPath) return null;
		// `rootPath` is top level in harper-config.yaml, so it is the one key readable off a
		// single line without tracking indentation. A YAML parser would be a dependency taken
		// on to read one key.
		const settings = readFileSync(settingsPath, 'utf-8');
		const rootPath = settings.match(/^rootPath[ \t]*:[ \t]*(.+?)[ \t]*(?:#.*)?$/m)?.[1].replace(/^(['"])(.*)\1$/, '$2');
		// Rejects `rootPath: null`, which is what Harper's own defaultConfig.yaml ships, along
		// with anything relative: a worker's cwd is not Harper's.
		return rootPath && isAbsolute(rootPath) ? rootPath : null;
	} catch {
		return null;
	}
}

/**
 * Harper's root path, or null when nothing names one.
 *
 * ROOTPATH is set by the harper-pro image and points at the mounted volume, so the Datadog
 * tree sits next to Harper's own state and survives a restart. Everywhere else, Harper's boot
 * properties are what name the root path.
 *
 * @returns {string | null}
 */
function harperRootPath() {
	return process.env.ROOTPATH || readHarperRootPath();
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
export function resolveRuntimeDir() {
	const rootPath = harperRootPath();
	if (rootPath) return join(rootPath, 'datadog');
	// Nothing named a root path. Fall back to a directory writable both in the container
	// (HOME=/home/harperdb) and in a developer shell.
	return join(homedir(), '.harper-datadog');
}

/**
 * Path to Harper's own log file, which the Datadog logs source tails.
 *
 * Never guessed from the home directory: a path that does not exist produces a logs source
 * that silently tails nothing, and says so nowhere. Each candidate is a root path Harper
 * itself recorded; when none of them answers, log collection is skipped with an explanation.
 *
 * `log/hdb.log` is Harper's default (`logging.root` defaults to `log`, and the log is named in
 * `LOG_NAMES.HDB`). An operator who relocates `logging.root` is not followed here, which
 * surfaces as the warning that the tailed file does not exist.
 */
export function resolveHarperLogPath() {
	const rootPath = harperRootPath();
	return rootPath ? join(rootPath, 'log', 'hdb.log') : null;
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
	return createHash('sha256').update(parts.join('\0')).digest().readUInt32BE(0) >>> 1;
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
	writeFileSync(temp, contents, 'utf-8');
	renameSync(temp, target);
}

/**
 * The datadog.yaml both binaries read. Rewritten on every start, so it is a projection of
 * this file rather than something to hand-edit. DD_API_KEY and DD_SITE are inherited from the
 * spawning environment instead, so no secret lands in the runtime tree.
 */
function renderDatadogYaml(paths) {
	return [
		'# GENERATED by dd-supervisor.js on every Harper worker start. Edits are overwritten.',
		'#',
		'# Every path is relocated off the Datadog defaults, which are unwritable for the',
		'# non-root user the deploy target runs as.',
		'#',
		'# api_key and site are absent by design: they come from DD_API_KEY / DD_SITE in the',
		'# environment, which keeps the key out of this file.',
		'',
		`confd_path: ${yamlString(paths.confd)}`,
		`run_path: ${yamlString(paths.run)}`,
		`auth_token_file_path: ${yamlString(paths.authToken)}`,
		`ipc_cert_file_path: ${yamlString(paths.ipcCert)}`,
		'',
		'# The agents write their own log files under the runtime tree, relocated off the',
		'# unwritable defaults. No worker thread collects their stdio: a pipe would tie both',
		'# agents to the thread that won the spawn race, and harper dev replaces that thread',
		'# on every save.',
		'log_to_console: false',
		`log_file: ${yamlString(paths.coreLog)}`,
		'',
		'# Off by default in the agent. The source itself is in conf.d.',
		'logs_enabled: true',
		'',
		'# Loopback only. Nothing here should be reachable from outside the container.',
		'bind_host: "127.0.0.1"',
		'',
		'apm_config:',
		'  enabled: true',
		`  receiver_port: ${RECEIVER_PORT}`,
		'  # On, this binds 0.0.0.0 and accepts spans from anything that reaches the container.',
		'  apm_non_local_traffic: false',
		`  log_file: ${yamlString(paths.traceLog)}`,
		'  # Pinned rather than left to the upstream default, because /DatadogStatus/ reads',
		'  # expvar off this port for its delivery signal. Loopback and TLS, both upstream.',
		'  debug:',
		`    port: ${DEBUG_PORT}`,
		'',
	].join('\n');
}

/**
 * Render the shipped logs source into the runtime conf.d. The template is version-controlled
 * with the component, but its `path` is absolute and machine-specific, so it carries
 * placeholders substituted here. See conf.d/harperdb.d/conf.yaml for the multi_line rule.
 */
function renderLogsConfig(componentDir, logPath, service) {
	const template = readFileSync(join(componentDir, 'conf.d', 'harperdb.d', 'conf.yaml'), 'utf-8');
	return template.replaceAll('__HDB_LOG_PATH__', logPath).replaceAll('__DD_SERVICE__', service);
}

/**
 * The package's own conf.d, which carries the core-check configurations.
 *
 * Resolved through the package rather than from the component directory, so the configurations
 * travel with the agent version they were written against: `harper deploy` replaces the
 * component, and a check that gained or lost a platform between agent releases would otherwise
 * be described by whatever the component was last deployed with.
 */
function resolvePackageConfd() {
	return join(dirname(createRequire(import.meta.url).resolve(`${PACKAGE_NAME}/package.json`)), 'conf.d');
}

/**
 * Names of the platforms a check directory applies to, from an optional `platforms` file
 * beside its config. Absent means every platform. Values are Node's (`linux`, `darwin`,
 * `win32`), because that is what they are compared against.
 *
 * A check with no implementation for the running platform is not inert: the collector reports
 * it under Loading Errors in `datadog-agent status`, which reads like a broken install rather
 * than like a check that was never going to run here.
 */
function readPlatformGate(checkDir) {
	let contents;
	try {
		contents = readFileSync(join(checkDir, 'platforms'), 'utf-8');
	} catch {
		return null;
	}
	return contents.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
}

/**
 * Write the shipped core-check configurations into the runtime conf.d, and return what was
 * written.
 *
 * Without them the agent collects no host metrics at all. Every core check is compiled into
 * the binary, but the collector schedules only what conf.d names: against an empty conf.d,
 * `configcheck` prints nothing and `status` reports "No checks have run yet". What keeps
 * flowing regardless is `datadog.agent.running`, which the aggregator appends to every flush
 * rather than collecting from a check, so the pipeline looks healthy while carrying nothing
 * about the host.
 *
 * Written as `conf.yaml.default`, upstream's own extension, because the file provider drops a
 * default whenever a plain `conf.yaml` for the same check sits in the same directory
 * (comp/core/autodiscovery/providers/config_reader.go). That gives an operator a per-check
 * override this function will not overwrite on the next start.
 *
 * The supervisor owns exactly the files named `conf.yaml.default` under
 * `<runtime>/conf.d/*.d/`, so anything it did not just write is stale and removed: the runtime
 * tree sits on a persistent volume and outlives both the container and the package version
 * that created it.
 */
function writeCoreCheckConfigs(confdPath, packageConfd) {
	const written = [];
	for (const entry of readdirSync(packageConfd, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (!entry.isDirectory() || !entry.name.endsWith('.d')) continue;
		const source = join(packageConfd, entry.name, 'conf.yaml.default');
		if (!existsSync(source)) continue;

		const platforms = readPlatformGate(join(packageConfd, entry.name));
		if (platforms && !platforms.includes(process.platform)) continue;

		const body = readFileSync(source, 'utf-8');
		const target = join(confdPath, entry.name);
		mkdirSync(target, { recursive: true });
		writeFileAtomic(join(target, 'conf.yaml.default'), body);
		written.push({ dir: entry.name, name: entry.name.slice(0, -'.d'.length), body });
	}

	const owned = new Set(written.map((check) => check.dir));
	for (const entry of readdirSync(confdPath, { withFileTypes: true })) {
		if (!entry.isDirectory() || owned.has(entry.name)) continue;
		rmSync(join(confdPath, entry.name, 'conf.yaml.default'), { force: true });
	}

	return written;
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
	if (binaryPath.includes(' ')) {
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

/**
 * True if a real trace-agent is serving this port.
 *
 * A bare TCP connect proves nothing: any stray socket or health-check stub accepts one,
 * and reading that as "APM is up" is the failure this component exists to make visible.
 * /info is served only by the trace-agent, and it lists the endpoints it accepts.
 */
async function isReceiverHealthy(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(1000) });
		if (!response.ok) return false;
		const body = await response.json();
		return (
			Array.isArray(body.endpoints) &&
			body.endpoints.some((endpoint) => typeof endpoint === 'string' && endpoint.includes('/traces'))
		);
	} catch {
		return false;
	}
}

/** Poll until a receiver answers, the agent dies, or the deadline passes. */
async function waitForReceiver(state, port, timeoutMs = RECEIVER_BIND_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await isReceiverHealthy(port)) return true;
		// Nothing binds after the process is gone, and its exit handler has already said
		// what happened; waiting out the deadline would only delay the report.
		if (state.exited || Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, RECEIVER_POLL_INTERVAL_MS));
	}
}

/**
 * The one claim in this status that can be checked instead of assumed.
 *
 * Everything else here reports that `spawn` did not throw, which is exactly what the
 * core-agent-only release reported while every span was dropped. Measured against the
 * shipped 7.82.1 binary, `trace-agent run` with apm_config.enabled false exits 0 having
 * bound nothing, so neither "started" nor the exit code carries this.
 */
async function verifyReceiver(status, paths) {
	const trace = status.agents.find((agent) => agent.kind === 'trace');
	if (!trace?.started) return;

	if (status.receiverPort === 0) {
		trace.receiverBound = false;
		log.warn(
			`Datadog supervisor: apm_config.receiver_port is 0, which turns the trace-agent's ` +
				`HTTP receiver off. dd-trace's default target goes unserved, so spans reach ` +
				`Datadog only over a Unix socket.`
		);
		return;
	}

	trace.receiverBound = await waitForReceiver(trace, status.receiverPort);
	if (trace.receiverBound) {
		log.info(
			`Datadog supervisor: the trace-agent is serving the APM receiver on ` +
				`127.0.0.1:${status.receiverPort}; dd-trace has somewhere to send spans.`
		);
		return;
	}

	log.error(
		`Datadog supervisor: the trace-agent (pid ${trace.pid}) was started but nothing ` +
			`answered /info on 127.0.0.1:${status.receiverPort} within ` +
			`${RECEIVER_BIND_TIMEOUT_MS / 1000}s. dd-trace has nowhere to send spans and reports ` +
			`a successful flush either way, so an empty APM page is the only symptom this ` +
			`produces on its own. Read ${paths.traceLog}, and check that DD_APM_ENABLED is not ` +
			`false in Harper's environment: it overrides the apm_config.enabled written into ` +
			`${paths.configFile}.`
	);
}

/**
 * Whether this thread has ever seen the trace-agent report an accepted payload.
 *
 * Every counter behind the delivery signal is a one-minute window the agent resets, so a
 * healthy node that served no traffic in the last minute reads exactly like a broken one.
 * This is the high-water mark that separates them, and it is per worker thread because
 * that is the only state a component instance has.
 */
let deliveryObserved = false;

/** GET a loopback HTTPS URL, resolving to the body or to null. Never throws. */
function fetchLoopbackTls(url, timeoutMs) {
	return new Promise((resolve) => {
		// The agent serves expvar under its own IPC certificate, which is self-signed by
		// construction and regenerated into the runtime tree on every start, so there is no
		// CA to pin it to. Upstream's own client does the same thing. Safe here and only
		// here: the connection never leaves the loopback interface, and the endpoint is
		// read-only. Never widen this to a host that is not 127.0.0.1.
		const call = httpsRequest(url, { rejectUnauthorized: false, timeout: timeoutMs }, (response) => {
			if (response.statusCode !== 200) {
				response.resume();
				resolve(null);
				return;
			}
			let body = '';
			response.setEncoding('utf-8');
			response.on('data', (chunk) => (body += chunk));
			response.on('end', () => resolve(body));
		});
		call.on('timeout', () => call.destroy());
		call.on('error', () => resolve(null));
		call.end();
	});
}

/** How long the expvar read gets. It runs inside a request handler, so it cannot hang. */
const DELIVERY_READ_TIMEOUT_MS = 2000;

/** Sum one numeric field across the receiver's per-client entries. */
function sumReceiver(entries, field) {
	return entries.reduce((total, entry) => total + (Number(entry?.[field]) || 0), 0);
}

/**
 * Whether spans are reaching Datadog, read from the trace-agent's own counters.
 *
 * `datadog-agent status` has a `Writer (previous minute)` section that looks like the answer
 * and is not one. On 7.82.1 it renders `trace_writer` straight out of this same expvar, and
 * that key is unusable: upstream constructs two TraceWriters unconditionally
 * (pkg/trace/agent/agent.go), each spawns a `reporter()` goroutine whose second statement is
 * `info.UpdateTraceWriterInfo(w.statsLastMinute)`, and that function overwrites a single
 * global pointer (pkg/trace/info/writer.go). The v1.0 writer receives nothing unless the
 * `convert-traces` feature flag is on, so when its goroutine registers last the published
 * struct belongs to a writer that never sends anything and every field reads zero for the
 * life of the process. Introduced in 7.73.0 and unfixed upstream as of 7.82.1. Measured
 * here: 55 samples over two minutes with traffic flowing and payloads being retried and
 * dropped, `trace_writer` identically zero in all of them - Errors and Retries included -
 * while `receiver` and `stats_writer` in the same reads moved normally.
 *
 * `stats_writer` is the substitute rather than a proxy for one. It has a single producer,
 * so it cannot lose the same race, and its `Payloads` counter increments only on the
 * `eventTypeSent` branch, which the sender takes only for a 2xx. Its payloads go to the same
 * host with the same API key over the same sender as the trace payloads, and they are built
 * only from spans that were actually received. So `Payloads > 0` means spans arrived, were
 * processed, and the intake accepted an authenticated POST.
 *
 * Verified against a bogus API key: `receiver` climbed, `stats_writer.Retries` climbed, and
 * `Payloads` stayed at 0. The counter discriminates.
 *
 * @returns {Promise<object>} never rejects; an unreachable endpoint is a verdict, not a throw
 */
export async function readDeliverySignal(port = DEBUG_PORT) {
	const source = `https://127.0.0.1:${port}/debug/vars`;

	if (port === 0) {
		return unavailable(source, 'apm_config.debug.port is 0, which turns the expvar endpoint off.');
	}

	const body = await fetchLoopbackTls(source, DELIVERY_READ_TIMEOUT_MS);
	if (body === null) {
		return unavailable(
			source,
			`nothing answered ${source}. The trace-agent is not running, or it is not the one this node started.`
		);
	}

	try {
		return deliveryVerdict(JSON.parse(body), source);
	} catch (error) {
		return unavailable(source, `${source} did not return the expected JSON: ${error.message}`);
	}
}

/** The shape every delivery verdict carries, so a caller can read it without branching. */
function deliveryBase(source) {
	return {
		source,
		// Said in the payload because the numbers are meaningless without it: both windows
		// reset every minute, so zero on a quiet node is silence, not failure.
		window: 'the last completed minute; the agent resets these counters, so they are not cumulative',
		traceWriterIgnored:
			'trace_writer reads zero on 7.73.0 through at least 7.82.1 whatever the agent is ' +
			'doing (two writers, one global expvar slot, last registration wins). That is the ' +
			'field `datadog-agent status` renders under "Writer (previous minute)".',
	};
}

function unavailable(source, detail) {
	return { ...deliveryBase(source), verdict: 'unavailable', detail };
}

/**
 * Turn one expvar body into a delivery verdict. Pure, and separate from the read so the
 * decision can be tested against bodies a live agent would take minutes to produce.
 *
 * @param {object} vars parsed /debug/vars
 * @param {string} source the URL it came from, for the report
 */
export function deliveryVerdict(vars, source = `https://127.0.0.1:${DEBUG_PORT}/debug/vars`) {
	const signal = deliveryBase(source);
	const entries = Array.isArray(vars?.receiver) ? vars.receiver : [];
	const stats = vars?.stats_writer ?? {};

	signal.agentVersion = vars?.version?.Version;
	signal.uptimeSeconds = Number(vars?.uptime) || 0;
	signal.receiver = {
		tracesReceived: sumReceiver(entries, 'TracesReceived'),
		spansReceived: sumReceiver(entries, 'SpansReceived'),
		payloadAccepted: sumReceiver(entries, 'PayloadAccepted'),
		payloadRefused: sumReceiver(entries, 'PayloadRefused'),
		payloadTimeout: sumReceiver(entries, 'PayloadTimeout'),
		spansDropped: sumReceiver(entries, 'SpansDropped'),
		// Which tracers are talking to it. Empty means nothing sent in the last minute,
		// which on a Harper node means no request reached a thread with a live tracer.
		clients: entries.map((entry) => `${entry?.Lang ?? '?'} ${entry?.TracerVersion ?? '?'}`),
	};
	signal.statsWriter = {
		payloads: Number(stats.Payloads) || 0,
		errors: Number(stats.Errors) || 0,
		retries: Number(stats.Retries) || 0,
		bytes: Number(stats.Bytes) || 0,
		// Not delivery, but evidence that the last minute contained work at all: the
		// concentrator builds these from spans that were received, before anything is sent.
		// They are what separates a stale receiver window from a live one below.
		buckets: Number(stats.StatsBuckets) || 0,
		clientPayloads: Number(stats.ClientPayloads) || 0,
	};

	if (signal.statsWriter.payloads > 0) deliveryObserved = true;
	signal.everDelivered = deliveryObserved;

	const arriving = signal.receiver.tracesReceived > 0 || signal.receiver.spansReceived > 0;
	// Whether the stats writer saw the same minute the receiver claims. Upstream refreshes the
	// receiver snapshot only when a payload arrives (pkg/trace/api/api.go), so on a node that
	// has gone quiet the last busy minute stays published indefinitely while the stats window
	// correctly resets to zero. Reading that pair as a failure reports a healthy idle node as
	// broken, which is the exact failure this signal exists to stop making.
	const statsSawWork = signal.statsWriter.buckets > 0 || signal.statsWriter.clientPayloads > 0;
	if (signal.statsWriter.payloads > 0) {
		signal.verdict = 'delivering';
		signal.detail = `the intake accepted ${signal.statsWriter.payloads} payload(s) in the last minute.`;
	} else if (signal.statsWriter.retries > 0 || signal.statsWriter.errors > 0) {
		signal.verdict = 'rejected';
		signal.detail =
			`the intake refused every payload (${signal.statsWriter.retries} retries, ` +
			`${signal.statsWriter.errors} errors) and accepted none. Check DD_API_KEY and DD_SITE.`;
	} else if (arriving && statsSawWork) {
		signal.verdict = 'not-delivering';
		signal.detail =
			`spans are arriving (${signal.receiver.spansReceived} in the last minute) and nothing ` +
			`has been accepted. Read this again before believing it: both windows reset each ` +
			`minute, and a read seconds after startup can land before the first flush.`;
	} else if (arriving) {
		signal.verdict = 'idle';
		signal.detail =
			`the receiver still shows ${signal.receiver.spansReceived} spans, but the stats ` +
			`writer saw no work in the last minute. The receiver snapshot is only refreshed when ` +
			`a payload arrives, so that reading is from the last busy minute, not this one.`;
	} else if (deliveryObserved) {
		signal.verdict = 'idle';
		signal.detail = 'no spans in the last minute, but this thread has seen delivery succeed since it started.';
	} else {
		signal.verdict = 'idle';
		signal.detail =
			'no spans reached the trace-agent in the last minute. Call GET /Work/ a few times ' +
			'and read this again; nothing here can distinguish a quiet node from a broken tracer.';
	}
	return signal;
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
		if (!binaryPath) throw new Error('its path could not be resolved');
		preflightBinary(descriptor.title, binaryPath);
	} catch (error) {
		state.error = error.message;
		log.error(`Datadog supervisor: cannot start the ${descriptor.title}: ${error.message}`);
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
			// Never piped. A pipe ties both agents to the worker thread that won the spawn
			// race: when harper dev recycles that thread on a save, the agents die on
			// SIGPIPE at their next write, the PID file survives them, and every later
			// thread adopts the corpse and reports "already running" forever. The agents
			// write their own log files under the runtime tree instead (renderDatadogYaml).
			stdio: ['ignore', 'ignore', 'ignore'],
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
	child.on('error', (error) => {
		// ENOEXEC is the one spawn failure preflightBinary() cannot see coming: X_OK passes
		// for a binary built for another architecture, and the bare message is "Exec format
		// error". src/agent-launcher.ts names the same case for the bin/ shims.
		const detail =
			error.code === 'ENOEXEC'
				? `${binaryPath} is not executable code for this machine (ENOEXEC). A platform ` +
					`package filled from another architecture produces exactly this; check with ` +
					`\`file ${binaryPath}\`.`
				: error.message;
		log.error(`Datadog supervisor: the ${descriptor.title} failed to execute: ${detail}`);
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

	// Agent output no longer reaches hdb.log, so say where it went instead.
	log.info(
		`Datadog supervisor: started the ${descriptor.title} (pid ${child.pid}): ` +
			`${binaryPath} ${args.join(' ')}. It logs to ` +
			`${join(paths.runtimeDir, 'logs')}.`
	);

	child.on('exit', (code, signal) => {
		// Read by waitForReceiver(), which has nothing left to wait for once the process
		// it was watching is gone.
		state.exited = true;
		if (signal) {
			const stopped = `Datadog supervisor: the ${descriptor.title} was terminated by ${signal}.`;
			// SIGTERM/SIGINT/SIGHUP are someone asking it to stop. SIGKILL is usually the OOM
			// killer and the rest are crashes; reporting those at warn buries them.
			if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGHUP') {
				log.warn(stopped);
			} else {
				log.error(`${stopped} That is a crash or an OOM kill rather than a shutdown.`);
			}
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

/**
 * Start the reaper, or say why it was not started.
 *
 * The command has to satisfy Harper's allowlist, which is an exact string compare against
 * `command.split(' ')[0]`. `process.execPath` is tried first because it names this exact Node
 * and cannot be shadowed by PATH; bare `node` is the fallback and is what works with no
 * configuration at all, since it is in Harper's own default allowlist and in the example's.
 * A refused spawn throws synchronously and creates no PID file, so trying both costs nothing.
 *
 * Never fatal. Without a reaper the agents run exactly as they did before, and outlive the
 * node exactly as they did before; that is worth a warning, not an outage.
 */
function launchReaper(componentDir, paths, rootPath, agents, version) {
	const state = { name: REAPER.name, started: false };

	const running = agents.filter((agent) => agent.started && typeof agent.pid === 'number');
	if (running.length === 0) {
		state.error = 'no agent started, so there is nothing to stop';
		return state;
	}
	if (!rootPath) {
		state.error = "Harper's root path is unknown, so the PID files to clean up cannot be located";
		log.warn(
			`Datadog supervisor: not starting the ${REAPER.title}: ${state.error}. The agents ` +
				`will keep running after this node stops; kill them by hand or set ROOTPATH.`
		);
		return state;
	}

	const script = join(componentDir, REAPER.script);
	if (!existsSync(script)) {
		state.error = `${script} is missing`;
		log.error(
			`Datadog supervisor: cannot start the ${REAPER.title}: ${script} is missing. It ` +
				`ships beside dd-supervisor.js and has to be copied with it. Without it the ` +
				`agents keep running after this node stops and 127.0.0.1:${RECEIVER_PORT} stays bound.`
		);
		return state;
	}

	const pidDir = join(rootPath, 'pids');
	const args = [
		script,
		// The worker thread's process.pid IS the main Harper process: threads share a process.
		// That is also the pid `harper stop` signals and the one this becomes a child of.
		'--harper-pid',
		String(process.pid),
		'--hdb-pid-file',
		join(rootPath, 'hdb.pid'),
		'--restart-grace-ms',
		String(REAPER_RESTART_GRACE_MS),
		'--self-pid-file',
		join(pidDir, `${REAPER.name}.pid`),
		'--log',
		join(paths.runtimeDir, 'logs', 'reaper.log'),
		...running.flatMap((agent) => ['--agent', `${join(pidDir, `${agent.name}.pid`)}:${agent.pid}`]),
	];

	let child;
	const refusals = [];
	for (const command of [process.execPath, 'node']) {
		try {
			child = spawn(command, args, {
				name: REAPER.name,
				version,
				stdio: ['ignore', 'ignore', 'ignore'],
				env: process.env,
			});
			state.command = command;
			break;
		} catch (error) {
			refusals.push(`${command}: ${error.message}`);
		}
	}

	if (!child) {
		state.error = refusals.join('; ');
		log.warn(
			`Datadog supervisor: Harper refused to start the ${REAPER.title} (${state.error}). ` +
				`Add \`node\` back to applications.allowedSpawnCommands, or add ` +
				`${process.execPath}. Without it the agents keep running after \`harper stop\` ` +
				`and 127.0.0.1:${RECEIVER_PORT} stays bound.`
		);
		return state;
	}

	state.pid = child.pid;
	state.started = true;
	child.on('error', (error) =>
		log.error(`Datadog supervisor: the ${REAPER.title} failed to execute: ${error.message}`)
	);

	state.adopted = !Array.isArray(child.spawnargs);
	if (state.adopted) {
		log.info(
			`Datadog supervisor: the ${REAPER.title} is already running on this node ` +
				`(pid ${child.pid}); this thread joined it instead of starting a second one.`
		);
		child.unref();
		return state;
	}

	log.info(
		`Datadog supervisor: started the ${REAPER.title} (pid ${child.pid}). It watches Harper ` +
			`(pid ${process.pid}) and stops ${running.map((agent) => agent.name).join(' and ')} ` +
			`when this node exits, which Harper itself never does for a component's spawns.`
	);
	child.on('exit', (code, signal) => {
		if (signal || code === 0) return;
		log.warn(
			`Datadog supervisor: the ${REAPER.title} exited with code ${code}. The agents will ` +
				`now outlive this node; \`harper stop\` will leave them running.`
		);
	});
	return state;
}

/**
 * Create the runtime tree and write every config file the agents read from it.
 *
 * Exported for the hermetic suite, which asserts the tree it produces rather than the strings
 * that went into it: what the agent reads is the tree, and the defect this guards against was
 * a tree that was written correctly and simply had nothing in it about the host.
 */
export function prepareRuntime(componentDir) {
	const runtimeDir = resolveRuntimeDir();
	const paths = {
		runtimeDir,
		configFile: join(runtimeDir, 'datadog.yaml'),
		confd: join(runtimeDir, 'conf.d'),
		run: join(runtimeDir, 'run'),
		authToken: join(runtimeDir, 'run', 'auth_token'),
		ipcCert: join(runtimeDir, 'run', 'ipc_cert.pem'),
		coreLog: join(runtimeDir, 'logs', 'agent.log'),
		traceLog: join(runtimeDir, 'logs', 'trace-agent.log'),
	};

	mkdirSync(paths.run, { recursive: true });
	mkdirSync(join(runtimeDir, 'logs'), { recursive: true });
	mkdirSync(join(paths.confd, 'harperdb.d'), { recursive: true });

	// The trace-agent writes its auth token beside the config file. Without write access it
	// does not fail fast: it hangs for 30 seconds, then dies on "error while creating or
	// fetching auth token", which reads like a network problem.
	accessSync(runtimeDir, constants.W_OK);

	// The trace-agent is fatal without a config file that EXISTS; the contents may be empty.
	const datadogYaml = renderDatadogYaml(paths);
	writeFileAtomic(paths.configFile, datadogYaml);

	let checks = [];
	try {
		checks = writeCoreCheckConfigs(paths.confd, resolvePackageConfd());
	} catch (error) {
		// Host metrics are optional in the same sense log collection is: worth a warning, not
		// worth taking APM down for. The trace-agent is what must not be blocked here.
		log.warn(
			`Datadog supervisor: no core check configuration was written (${error.message}). The ` +
				`agent will still run, and will still report datadog.agent.running, but it will ` +
				`collect no host metrics. Traces and logs are unaffected.`
		);
	}

	const service = process.env.DD_SERVICE || 'harper';
	const logPath = resolveHarperLogPath();
	let logsYaml = '';
	if (logPath) {
		try {
			logsYaml = renderLogsConfig(componentDir, logPath, service);
			writeFileAtomic(join(paths.confd, 'harperdb.d', 'conf.yaml'), logsYaml);
			if (!existsSync(logPath)) {
				log.warn(
					`Datadog supervisor: Harper's log file ${logPath} does not exist yet. The agent ` +
						`will tail it once it appears, but if it never does, logging.file is off or ` +
						`logging.path points somewhere else.`
				);
			}
		} catch (error) {
			// Log collection is optional; the trace-agent is not. This block used to throw
			// out of prepareRuntime, and the catch around it stopped BOTH spawns, so a
			// renamed conf.d template took APM down with it. Reset rather than keep a
			// half-rendered string: the fingerprint has to describe what was written.
			logsYaml = '';
			log.warn(
				`Datadog supervisor: no log source was written (${error.message}). The template ` +
					`is conf.d/harperdb.d/conf.yaml under the component directory, and it has to be ` +
					`readable by the Harper user. Traces are unaffected.`
			);
		}
	} else {
		log.warn(
			`Datadog supervisor: no log source was written, because Harper's root path could ` +
				`not be determined: ROOTPATH is unset, and ~/.harperdb/hdb_boot_properties.file ` +
				`did not lead to a config carrying rootPath. Set ROOTPATH to enable log ` +
				`collection. Traces are unaffected.`
		);
	}

	return {
		paths,
		logPath,
		service,
		coreChecks: checks.map((check) => check.name),
		fingerprint: datadogYaml + logsYaml + checks.map((check) => check.body).join(''),
	};
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
			apiKey: process.env.DD_API_KEY ? 'set' : 'MISSING',
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
				'Datadog supervisor: DD_API_KEY is not set. Both agents will start and the ' +
					'trace-agent will accept spans from dd-trace, but the intake rejects the ' +
					'payloads and they are discarded. Nothing will appear in Datadog.'
			);
		}

		try {
			const runtime = prepareRuntime(componentDir);
			status.runtimeDir = runtime.paths.runtimeDir;
			status.configFile = runtime.paths.configFile;
			status.harperLogPath = runtime.logPath;
			status.service = runtime.service;
			status.coreChecks = runtime.coreChecks;

			const manager = new BinaryManager();
			// Resolve both paths up front. The version covers the pair, and each path is then
			// handed to the spawn that uses it, so the fingerprint can never describe a
			// different binary from the one started. A resolution failure becomes an empty
			// string and is reported per-agent by launchOne().
			const binaries = await Promise.all(
				AGENTS.map((descriptor) =>
					descriptor.resolve(manager).catch((error) => {
						log.error(`Datadog supervisor: could not resolve the ${descriptor.title} ` + `binary: ${error.message}`);
						return '';
					})
				)
			);
			// The credentials ride in the inherited environment, never in the config files,
			// so they are invisible to the fingerprint unless folded in here; without them a
			// rotated DD_API_KEY leaves the running agents posting the old key forever.
			const version = configVersion(
				runtime.fingerprint,
				process.env.DD_API_KEY ?? '',
				process.env.DD_SITE ?? '',
				process.env.DD_ENV ?? '',
				...binaries
			);
			status.version = version;

			// In order, trace-agent first: it owns the socket dd-trace is already trying to
			// reach.
			for (const [index, descriptor] of AGENTS.entries()) {
				status.agents.push(launchOne(descriptor, binaries[index], runtime.paths, version));
			}

			// Before verifyReceiver, which waits up to 30s for the receiver to answer. Starting
			// the reaper after that leaves a half-minute window in which the agents exist and
			// nothing would stop them, and a node killed inside it orphans them.
			// Deliberately not in `agents`: it is not a Datadog process, and the checks that
			// count agents must not start counting it.
			status.reaper = launchReaper(componentDir, runtime.paths, harperRootPath(), status.agents, version);

			await verifyReceiver(status, runtime.paths);
		} catch (error) {
			status.error = error.message;
			log.error(`Datadog supervisor: startup failed: ${error.message}`);
		}

		return status;
	})();

	return started;
}
