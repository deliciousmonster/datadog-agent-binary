import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { BinaryManager } from './binary-manager.js';
import { errorMessage, logger, BUILD_FROM_SOURCE_HINT } from './logger.js';
import { Platform } from './platform.js';
import { AgentBinaryKind } from './types.js';

/**
 * The launcher shared by the `bin/datadog-agent` and `bin/trace-agent` shims. The only
 * thing that varies between them is the `AgentBinaryKind` they pass in; everything
 * kind-specific hangs off the descriptor for that kind.
 *
 * `launchAgent()` never rejects. It owns the process lifecycle and calls `process.exit()`
 * on every terminal path, because an unhandled rejection in a launcher is the
 * silent-death mode this package exists to avoid.
 */

/** `apm_config.receiver_port` default. dd-trace targets the same port by default. */
const DEFAULT_RECEIVER_PORT = 8126;

/** Raised by preflight checks, to distinguish "misconfigured" from "binary not found". */
export class LaunchPreflightError extends Error {}

/**
 * Report which Datadog-relevant environment variables reached this process. The agent
 * disables itself (or silently collects nothing) without an API key or site, so this is
 * the first thing to check when no logs or traces are arriving.
 */
export function logDatadogEnv(kind: AgentBinaryKind): void {
	logger.info(
		`Datadog env visible to the ${kind} wrapper: ` +
			// Presence only: the key itself must never reach a log.
			`DD_API_KEY=${process.env.DD_API_KEY ? 'set' : 'MISSING'}, ` +
			`DD_SITE=${process.env.DD_SITE || 'MISSING'}, ` +
			`DD_ENV=${process.env.DD_ENV || 'MISSING'}, ` +
			`DD_HOSTNAME=${process.env.DD_HOSTNAME || '(default)'}, ` +
			`DD_LOGS_ENABLED=${process.env.DD_LOGS_ENABLED || '(unset, default false)'}, ` +
			`DD_LOG_TO_CONSOLE=${process.env.DD_LOG_TO_CONSOLE || '(unset, default true)'}`
	);

	// APM is a separate socket: the tracer talks to the trace-agent's receiver, not to the
	// core agent. A mismatch between what dd-trace dials (DD_TRACE_AGENT_URL) and what the
	// receiver binds (DD_APM_RECEIVER_PORT) drops every span with no error on either side.
	logger.info(
		`APM env visible to the ${kind} wrapper: ` +
			`DD_APM_ENABLED=${process.env.DD_APM_ENABLED || '(unset, default true)'}, ` +
			`DD_APM_RECEIVER_PORT=${process.env.DD_APM_RECEIVER_PORT || `(unset, default ${DEFAULT_RECEIVER_PORT})`}, ` +
			`DD_TRACE_AGENT_URL=${
				process.env.DD_TRACE_AGENT_URL || `(unset, dd-trace dials http://127.0.0.1:${DEFAULT_RECEIVER_PORT})`
			}`
	);

	if (!process.env.DD_API_KEY) {
		if (kind === 'trace') {
			// The receiver validates nothing at accept time. Spans are taken off the socket,
			// batched, and discarded when the payload cannot be shipped, so a keyless
			// trace-agent is indistinguishable from a working one on the application side.
			logger.warn(
				'DD_API_KEY is not set in this process. The trace-agent will still bind its ' +
					'receiver and accept spans from dd-trace, but the intake will reject the ' +
					'payloads and the spans are dropped. The application sees a successful flush ' +
					'either way, so an empty APM view is the only symptom. Export the API key into ' +
					'the spawning process (loadEnv) or set api_key in datadog.yaml.'
			);
		} else {
			logger.warn(
				'DD_API_KEY is not set in this process. The agent will start but disable ' +
					'its connection to Datadog, so nothing will appear in env:development. ' +
					'Confirm the API key is exported into the spawning process (loadEnv) or ' +
					"set in the component's datadog.yaml."
			);
		}
	}

	// Log collection is the core agent's job; the trace-agent ignores it entirely.
	if (kind === 'core' && !process.env.DD_LOGS_ENABLED) {
		logger.warn(
			'DD_LOGS_ENABLED is not set (defaults to false). Log collection is OFF, so ' +
				'application logs will not be forwarded to Datadog even when the agent is ' +
				'running. Set DD_LOGS_ENABLED=true (or logs_enabled: true in datadog.yaml) ' +
				'and configure a logs source.'
		);
	}
}

/**
 * Flags that name the config file. The trace-agent's own flag has changed across major
 * versions, so every spelling is accepted: guessing wrong would make the preflight below
 * check a file the agent never reads.
 */
const CONFIG_FLAGS = new Set(['-c', '--config', '-config', '--cfgpath', '-cfgpath']);

/**
 * Config file the trace-agent will load, as best as can be determined before it runs,
 * plus whether that path was stated or inferred. A `-c` pointing at a directory is
 * resolved the way the agent resolves it, to `<dir>/datadog.yaml`.
 *
 * The trace-agent does not use the OS-wide `/etc/datadog-agent/datadog.yaml` the core
 * agent does: its default is `filepath.Join(setup.InstallPath, "etc/datadog.yaml")`
 * (`cmd/trace-agent/command/command_nix.go`), and `osinit()` in
 * `pkg/config/setup/config_nix.go` reassigns `InstallPath` from the location of the
 * running executable. For a binary npm unpacked into node_modules that resolves inside
 * node_modules, which holds no datadog.yaml. Hence: derive from the binary, mark it as a
 * guess, and never let the guess block a launch.
 */
function resolveConfigPath(args: string[], binaryPath?: string): { configPath: string; explicit: boolean } {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.indexOf('=');
		let value: string | null = null;
		if (eq > 0 && CONFIG_FLAGS.has(arg.slice(0, eq))) {
			value = arg.slice(eq + 1);
		} else if (CONFIG_FLAGS.has(arg) && i + 1 < args.length) {
			value = args[i + 1];
		}
		if (value) {
			return {
				configPath: isDirectory(value) ? path.join(value, 'datadog.yaml') : value,
				explicit: true,
			};
		}
	}

	// No binary to derive from: upstream's compiled-in default, before osinit() rewrites it.
	const compiledInDefault =
		process.platform === 'win32'
			? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Datadog', 'datadog.yaml')
			: '/opt/datadog-agent/etc/datadog.yaml';

	// <installRoot>/bin/trace-agent -> <installRoot>/etc/datadog.yaml
	const derived = binaryPath ? path.join(path.dirname(path.dirname(binaryPath)), 'etc', 'datadog.yaml') : null;

	return { configPath: derived ?? compiledInDefault, explicit: false };
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Both failure modes the trace-agent has before it ever binds a socket, checked up front
 * because neither is legible from its own output:
 *
 *   missing datadog.yaml  -> immediate fatal "unable to load Datadog config file". The
 *                            file's *contents* are irrelevant; a 0-byte file works.
 *   unwritable config dir -> a 30 second hang, then "error while creating or fetching
 *                            auth token". The agent writes `auth_token` next to the
 *                            config file, and the deploy target is non-root, where
 *                            /etc/datadog-agent is not writable.
 *
 * Only fatal when the caller stated the config path. An inferred path is a guess, and
 * refusing to launch on a wrong guess turns a working configuration into a refused start;
 * in that case say what was checked and let the agent speak for itself.
 */
export function preflightTraceAgentConfig(args: string[], binaryPath?: string): void {
	const { configPath, explicit } = resolveConfigPath(args, binaryPath);
	const configDir = path.dirname(configPath);

	if (!fs.existsSync(configPath)) {
		if (!explicit) {
			logger.warn(
				`No config flag was passed, and there is no file at ${configPath}, the ` +
					`path the trace-agent derives from its own location. It will almost ` +
					`certainly exit immediately with "unable to load Datadog config file". ` +
					`Pass -c <path> to a datadog.yaml in a directory this user can write ` +
					`(the file may be empty; the agent writes its auth_token beside it).`
			);
			return;
		}
		throw new LaunchPreflightError(
			`The trace-agent needs a config file at ${configPath} and there is none. It ` +
				`would exit immediately with "unable to load Datadog config file". The file ` +
				`only has to exist: an empty one is enough (mkdir -p ${configDir} && touch ` +
				`${configPath}). Pass -c <path> to point at a different config, and note that ` +
				`the deploy target is non-root, so a path under the Harper root is usually the ` +
				`right answer rather than /etc/datadog-agent.`
		);
	}

	try {
		fs.accessSync(configDir, fs.constants.W_OK);
	} catch {
		throw new LaunchPreflightError(
			`The trace-agent config directory ${configDir} is not writable by uid ${
				typeof process.getuid === 'function' ? process.getuid() : '?'
			}. The agent writes its auth_token there, and without write access it hangs for ` +
				`30 seconds and dies with "error while creating or fetching auth token". Put ` +
				`datadog.yaml somewhere this user owns and pass -c <path>.`
		);
	}

	logger.debug(`trace-agent config preflight passed: ${configPath} exists, ${configDir} is writable`);
}

/** Receiver port the trace-agent will bind, matching `apm_config.receiver_port`. */
function receiverPort(): number {
	const raw = process.env.DD_APM_RECEIVER_PORT;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return parsed > 0 ? parsed : DEFAULT_RECEIVER_PORT;
}

/**
 * True if `args` invoke the trace-agent's long-running receiver.
 *
 * The receiver starts for a bare invocation or an explicit `run`. Everything else
 * (`version`, `--help`) is a short-lived query that must still work while a receiver is
 * up, so the already-running check must not swallow it.
 */
function isRunSubcommand(args: string[]): boolean {
	const firstPositional = args.find((arg) => !arg.startsWith('-'));
	return firstPositional === undefined || firstPositional === 'run';
}

/**
 * True if a real trace-agent is serving this port.
 *
 * A bare TCP connect is not sufficient evidence: any leftover socket, container port
 * forward, or health-check stub accepts connections, and treating that as "APM is already
 * handled" reproduces the exact failure this package fixes. `/info` is served only by the
 * trace-agent and lists the endpoints it accepts.
 */
async function isTraceReceiverHealthy(port: number, timeoutMs = 1000): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/info`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return false;
		const body = (await response.json()) as { endpoints?: unknown };
		// Without the endpoint dd-trace submits to, whatever is answering is not a
		// trace-agent we can rely on.
		return (
			Array.isArray(body.endpoints) &&
			body.endpoints.some((endpoint) => typeof endpoint === 'string' && endpoint.includes('/traces'))
		);
	} catch {
		return false;
	}
}

/**
 * True if something already accepts connections on the receiver port. Used only to tell
 * "nothing is there" apart from "something is there but it is not a trace-agent".
 */
function isPortBound(port: number, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		// A later event after the first is a no-op: a promise settles once and destroy()
		// on a destroyed socket does nothing.
		const finish = (bound: boolean) => {
			socket.destroy();
			resolve(bound);
		};
		const socket = net.createConnection({ port, host: '127.0.0.1' });
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false));
		socket.once('error', () => finish(false));
	});
}

/**
 * Resolve one agent binary and run it, forwarding `args` and this process's env.
 *
 * @param kind which binary to launch; `core` is the metrics/logs agent, `trace` is the
 *   APM receiver that binds 127.0.0.1:8126.
 * @param args arguments for the binary. The default covers both invocation shapes the
 *   shims use: `node bin/datadog-agent <args>` puts the script at argv[1], and the
 *   Windows `node -e "<code>" "<dir>" <args>` wrapper puts the wrapper dir there, so user
 *   arguments start at index 2 either way.
 */
export async function launchAgent(
	kind: AgentBinaryKind = 'core',
	args: string[] = process.argv.slice(2)
): Promise<void> {
	// Error-path fallback only, so a getBinary() throw still has a name to report. The
	// descriptor below is the authority.
	let processName = `datadog-${kind}-agent-unresolved`;
	// Hoisted so the catch can name the path in an allowlist-rejection message: Harper's
	// gate throws synchronously from spawn(), after resolution has succeeded.
	let resolvedBinaryPath: string | undefined;
	try {
		const descriptor = Platform.current().getBinary(kind);
		processName = descriptor.processName;

		logDatadogEnv(kind);

		// Resolve the binary FIRST, always. An earlier revision short-circuited on a bound
		// receiver port before this line, so `trace-agent run` could exit 0 while the
		// trace-agent binary was not installed at all: APM looks healthy, nothing speaking
		// the trace protocol is listening, every span is dropped. Resolution failures must
		// always be loud.
		const binaryPath = await new BinaryManager().ensureBinary(kind);
		resolvedBinaryPath = binaryPath;

		if (kind === 'trace') {
			// After resolution, not before: with no explicit -c the trace-agent derives its
			// config path from where its own executable sits, so the check needs the binary.
			preflightTraceAgentConfig(args, binaryPath);

			// Only the invocations that bind the receiver: a `version` query has to keep
			// working while one is already up.
			if (isRunSubcommand(args)) {
				const port = receiverPort();
				if (await isTraceReceiverHealthy(port)) {
					logger.info(
						`A trace-agent receiver is already listening on 127.0.0.1:${port} and ` +
							`answered /info; not starting a second one. dd-trace will reach the ` +
							`running receiver, so this is a successful no-op, not a failure.`
					);
					process.exit(0);
				}
				if (await isPortBound(port)) {
					// Something holds the port but does not speak the trace protocol. Starting
					// anyway yields a real EADDRINUSE instead of reporting success next to a
					// stray socket.
					logger.warn(
						`127.0.0.1:${port} is bound but did not answer the trace-agent /info ` +
							`endpoint, so it is not a healthy receiver. Starting the trace-agent ` +
							`anyway; if that port is held by an unrelated process this will fail ` +
							`with EADDRINUSE rather than silently pretending APM is working.`
					);
				}
			}
		}

		logger.info(`Spawning ${processName}: ${binaryPath} ${args.join(' ')} (cwd=${process.cwd()})`);

		// `name` is passed for correctness, but do NOT rely on it here.
		//
		// Harper substitutes its constrained child_process only for modules its own loader
		// evaluates, and only on the ESM path: its CommonJS bridge forwards a builtin
		// specifier straight to Node's real `require`. This file compiles to CommonJS, so
		// `spawn` below is stock Node, which ignores `name`. No PID lock is taken and no
		// allowlist is consulted when the launcher runs.
		//
		// That makes these launchers CLI entry points, not a way to get one agent per node.
		// Component code needing the singleton must spawn from its own module graph via a
		// relative ESM import; see example/dd-supervisor.js. The branch below is kept
		// because `name` IS honoured when this module is loaded through Harper's ESM path.
		const child = spawn(binaryPath, args, {
			stdio: 'inherit',
			env: process.env,
			name: processName,
		} as any);

		// Every loser of Harper's PID-file race gets an ExistingProcessWrapper back instead
		// of a ChildProcess: an EventEmitter carrying pid, kill(), unref(), and an 'exit'
		// event, with no stdio and no spawnargs. Its 1Hz liveness interval is not unref'd,
		// so a thread that joined an existing process never goes idle unless it unrefs.
		if (!Array.isArray((child as unknown as { spawnargs?: string[] }).spawnargs)) {
			logger.info(
				`${processName} is already running on this node (pid=${child.pid}); this ` +
					`thread joined the existing process instead of starting a second one.`
			);
			child.unref();
			return;
		}

		logger.info(`${processName} child process started (pid=${child.pid})`);

		child.on('exit', (code, signal) => {
			void onExit(kind, processName, code, signal);
		});

		child.on('error', (error: Error) => {
			// Asynchronous spawn failures only: ENOENT, EACCES, and similar. Harper's
			// allowlist rejection is not one of these; createSpawn throws synchronously
			// before any child exists, so that case lands in the catch below.
			logger.error(`Failed to execute ${processName}: ${error.message}`);
			logger.error(`Binary path: ${binaryPath}`);
			process.exit(1);
		});
	} catch (error) {
		const message = errorMessage(error);
		logger.error(`Failed to run ${processName}: ${message}`);

		// Harper's spawn gate throws synchronously with "Command <cmd> is not allowed"
		// (security/jsLoader.ts) when the absolute path is absent from
		// applications.allowedSpawnCommands. The comparison is an exact string match on the
		// first space-delimited token, so each binary needs its own entry.
		if (/is not allowed/.test(message)) {
			logger.error(
				`Harper rejected this spawn. Add this exact absolute path to ` +
					`applications.allowedSpawnCommands and restart Harper (the allowlist is ` +
					`read once at module load): ${resolvedBinaryPath ?? '<unresolved>'}`
			);
		} else if (/must have a process "name"/.test(message)) {
			logger.error(
				`Harper requires a spawn "name" option. This launcher passes one, so this ` +
					`indicates a modified or unexpected call path.`
			);
		} else if (!(error instanceof LaunchPreflightError)) {
			logger.info(BUILD_FROM_SOURCE_HINT);
		}
		process.exit(1);
	}
}

async function onExit(
	kind: AgentBinaryKind,
	processName: string,
	code: number | null,
	signal: NodeJS.Signals | null
): Promise<void> {
	if (signal) {
		logger.warn(`${processName} terminated by signal ${signal}`);
		process.exit(0);
	}

	// A trace-agent that exits rc=1 because the receiver port was already taken is benign:
	// the port is served, so APM works. But rc=1 is also what a misconfigured agent
	// returns, and a bare port check cannot tell the two apart, so an unrelated listener
	// would turn every startup failure into a reported success. Require a healthy /info
	// response, which only a real trace-agent serves.
	if (kind === 'trace' && code === 1 && (await isTraceReceiverHealthy(receiverPort()))) {
		logger.info(
			`${processName} exited immediately while a healthy trace-agent receiver ` +
				`answered on 127.0.0.1:${receiverPort()}, which means another instance ` +
				`already owns the port (EADDRINUSE). Treating this as already-running.`
		);
		process.exit(0);
	}

	if (code) {
		logger.error(`${processName} exited with non-zero code ${code}`);
	} else {
		logger.info(`${processName} exited with code ${code}`);
	}
	process.exit(code || 0);
}

/**
 * Test-only handle on the supervision internals; not public API. Each member guards
 * a failure mode whose only production symptom is silently dropped spans, and without
 * this export the unit suite had to re-evaluate the compiled module through a
 * hand-built CJS wrapper to reach them.
 */
export const internalsForTesting = {
	receiverPort,
	isRunSubcommand,
	isTraceReceiverHealthy,
	onExit,
};
