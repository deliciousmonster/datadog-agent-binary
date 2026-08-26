import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
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

/** `apm_config.receiver_port: 0` is upstream's spelling for "serve no HTTP receiver". */
const RECEIVER_DISABLED = 0;

/**
 * How long a freshly spawned trace-agent gets to answer /info before the launch is called
 * a failure. Generous on purpose: the receiver check in .github/workflows/build-verify.yml
 * already treats 30s as the cold-start bound, and a deadline that fires early would refuse
 * a launch that was about to work.
 */
const RECEIVER_BIND_TIMEOUT_MS = 30_000;

const RECEIVER_POLL_INTERVAL_MS = 250;

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

/**
 * Receiver port the trace-agent will bind, matching `apm_config.receiver_port`.
 *
 * `0` is returned as itself. Upstream reads it as "serve no HTTP receiver" (the UDS-only
 * setup), so rewriting it to 8126 would make every probe here interrogate a port the
 * agent was told not to bind. Every other unparseable value is a typo, and the fallback
 * is announced rather than taken in silence: the agent reads the same variable and will
 * not agree with the guess, which is how a launcher comes to probe one port while the
 * receiver binds another.
 */
function receiverPort(): number {
	const raw = process.env.DD_APM_RECEIVER_PORT;
	if (!raw) return DEFAULT_RECEIVER_PORT;
	// The raw string, not the parsed value: parseInt("0abc") is also 0, and that is a
	// typo rather than a request to turn the receiver off.
	if (raw.trim() === '0') return RECEIVER_DISABLED;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
	logger.warn(
		`DD_APM_RECEIVER_PORT="${raw}" is not a port in 1-65535. Falling back to ` +
			`${DEFAULT_RECEIVER_PORT}, the port dd-trace dials, but the agent reads the same ` +
			`variable and will not resolve it the same way. Fix or unset it.`
	);
	return DEFAULT_RECEIVER_PORT;
}

/**
 * Global flags that consume the argument after them, per `trace-agent --help`. Without
 * this set, `-c <path> run` reads <path> as the subcommand, and every receiver check
 * keyed on `run` skips itself while saying nothing.
 */
const VALUE_FLAGS = new Set([...CONFIG_FLAGS, '-l', '--cpu-profile', '-m', '--mem-profile', '-p', '--pidfile']);

/**
 * Signals that mean someone asked the agent to stop. Everything else that kills it is a
 * crash or an OOM kill, and reporting one of those as a clean stop hides the death from
 * every restart policy, shell `&&`, and systemd unit that reads only the exit code.
 */
const GRACEFUL_SIGNALS = new Set<NodeJS.Signals>(['SIGTERM', 'SIGINT', 'SIGHUP']);

/** Flags that make the process print something and exit instead of serving. */
const QUERY_FLAGS = new Set(['-h', '--help']);

/**
 * True if `args` invoke the trace-agent's long-running receiver.
 *
 * The receiver starts for a bare invocation or an explicit `run`. Everything else
 * (`version`, `--help`) is a short-lived query that must still work while a receiver is
 * up, so the already-running check must not swallow it.
 */
function isRunSubcommand(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('-')) return arg === 'run';
		if (QUERY_FLAGS.has(arg)) return false;
		// `--flag=value` carries its own value; `--flag value` eats the next argument.
		if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i++;
	}
	return true;
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

/** `uid`, or a placeholder on a platform that has no such thing. */
function uidLabel(): string {
	return typeof process.getuid === 'function' ? String(process.getuid()) : '?';
}

/**
 * Why a spawn failed, when the reason is a property of the file rather than of the
 * configuration. Both of these arrive as a bare "Failed to execute", which reads like a
 * bad argument and sends people to look at datadog.yaml.
 *
 * A wrong-architecture binary passes every check this package makes: npm's os/cpu gate
 * covers the install, and nothing covers a build matrix leg that filled
 * build/linux-arm64/bin/ from an x86_64 runner.
 */
function describeSpawnFailure(error: unknown, binaryPath: string): string | null {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	if (code === 'ENOEXEC') {
		return (
			`${binaryPath} is not executable code for this machine (ENOEXEC). The platform ` +
			`package installed here must carry a ${Platform.current().getName()} binary; a build ` +
			`that filled it from another architecture produces exactly this. Check with ` +
			`\`file ${binaryPath}\`.`
		);
	}
	if (code === 'EACCES') {
		return (
			`${binaryPath} exists but uid ${uidLabel()} may not execute it (EACCES). npm ` +
			`preserves the mode bits; an archive unpacked by hand or a cache restored without ` +
			`them does not. \`chmod +x ${binaryPath}\`.`
		);
	}
	return null;
}

/**
 * Whether the receiver this launch is responsible for has ever been seen answering.
 * Written by waitForReceiver() and read by onExit(), because a trace-agent that exits 0
 * having never bound is indistinguishable, from the exit code alone, from one that served
 * spans for an hour and was then asked to stop.
 */
interface ReceiverWatch {
	port: number;
	bound: boolean;
}

/** Poll until a real receiver answers on the watched port, or the deadline passes. */
async function waitForReceiver(watch: ReceiverWatch, timeoutMs = RECEIVER_BIND_TIMEOUT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await isTraceReceiverHealthy(watch.port)) {
			watch.bound = true;
			return true;
		}
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, RECEIVER_POLL_INTERVAL_MS));
	}
}

/**
 * Hold the launch open until the receiver answers, and fail it loudly if it never does.
 *
 * The probe above runs before the spawn, to decide whether to start at all. Nothing used
 * to check afterwards, so a trace-agent that started and never bound was reported as a
 * success: `child process started (pid=N)`, then silence, then every span dropped. That
 * is the original defect with green output. Measured against the shipped 7.82.1 binary,
 * `trace-agent run` with DD_APM_ENABLED=false exits 0 having bound nothing.
 *
 * The assertion is on the observed socket, never on the config, so a configuration this
 * launcher does not understand cannot be refused as long as a receiver comes up.
 */
async function requireReceiverBound(
	watch: ReceiverWatch,
	child: ChildProcess,
	context: { processName: string; args: string[]; binaryPath: string; ownsChild: boolean }
): Promise<void> {
	if (await waitForReceiver(watch)) {
		logger.info(`${context.processName} is serving the APM receiver on 127.0.0.1:${watch.port}.`);
		return;
	}

	const { configPath, explicit } = resolveConfigPath(context.args, context.binaryPath);
	logger.error(
		`${context.processName} is running (pid=${child.pid}) but nothing answered the ` +
			`trace-agent /info endpoint on 127.0.0.1:${watch.port} within ` +
			`${RECEIVER_BIND_TIMEOUT_MS / 1000}s, so dd-trace has nowhere to send spans. It ` +
			`reports a successful flush either way, which is why an empty APM view is the only ` +
			`symptom this produces on its own. Config ` +
			`${explicit ? 'passed on the command line' : 'derived from the binary location'}: ` +
			`${configPath}. Check apm_config.enabled there, DD_APM_ENABLED=${
				process.env.DD_APM_ENABLED ?? '(unset)'
			} which overrides it, and then the agent's own log.`
	);

	// Only the thread that started it. Exiting otherwise leaves an agent alive that serves
	// nothing while holding the PID lock that keeps the next one from starting; killing a
	// process another thread owns is not this launch's call to make.
	if (context.ownsChild) child.kill('SIGTERM');
	process.exit(1);
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

		// Set only for the invocations this launch is responsible for binding, so the
		// post-spawn assertion below can never reach a `version` query or the core agent.
		let watch: ReceiverWatch | undefined;

		if (kind === 'trace') {
			// After resolution, not before: with no explicit -c the trace-agent derives its
			// config path from where its own executable sits, so the check needs the binary.
			preflightTraceAgentConfig(args, binaryPath);

			// Only the invocations that bind the receiver: a `version` query has to keep
			// working while one is already up.
			if (isRunSubcommand(args)) {
				const port = receiverPort();
				if (port === RECEIVER_DISABLED) {
					// Deliberate, so it is not refused. It is still the state where dd-trace's
					// default target goes unserved, which nothing else here would report.
					logger.warn(
						`DD_APM_RECEIVER_PORT=0 turns the trace-agent's HTTP receiver off, so ` +
							`nothing will listen on 127.0.0.1:${DEFAULT_RECEIVER_PORT} and dd-trace will ` +
							`drop every span unless it has been pointed at a Unix socket. Starting ` +
							`the agent and skipping the receiver checks.`
					);
				} else if (await isTraceReceiverHealthy(port)) {
					logger.info(
						`A trace-agent receiver is already listening on 127.0.0.1:${port} and ` +
							`answered /info; not starting a second one. dd-trace will reach the ` +
							`running receiver, so this is a successful no-op, not a failure.`
					);
					process.exit(0);
				} else if (await isPortBound(port)) {
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
				if (port !== RECEIVER_DISABLED) watch = { port, bound: false };
			}
		}

		logger.info(`Spawning ${processName}: ${binaryPath} ${args.join(' ')} (cwd=${process.cwd()})`);

		// `name` is passed for correctness, but do NOT rely on it here.
		//
		// Harper's loader never evaluates this package, so `spawn` below is stock Node: it
		// ignores `name`, takes no PID lock, and consults no allowlist. For a bare specifier
		// under node_modules, shouldUseApplicationLoader falls through to
		// packageDependsOnHarper, and this manifest names no Harper-claimed id. On that
		// native path createModule hands the URL to Node's own import() and wraps the result
		// as a SyntheticModule, which has no linker, so the loader never sees this package's
		// internal relative imports either. Measured against harper 5.2.1,
		// dist/security/jsLoader.js:499-517 and :656 (the built file, not security/jsLoader.ts,
		// whose line numbers differ). test/unit/harper-loader-claim.test.js keeps the premise
		// true: harper in ANY dependency key flips the routing.
		//
		// Three ways a caller puts this module back under the loader, where the spawn would
		// THROW rather than dedupe, since allowedSpawnCommands defaults to empty:
		// applications.dependencyLoader 'app'; a relative import reaching into node_modules;
		// a linked copy resolving under the component root.
		//
		// So these launchers are CLI entry points, not a way to get one agent per node, and
		// bin/ runs them in their own process where no loader exists at all. Component code
		// needing the singleton spawns from its own module graph via a relative import; see
		// example/dd-supervisor.js.
		const child = spawn(binaryPath, args, {
			stdio: 'inherit',
			env: process.env,
			name: processName,
		} as any);

		// Every loser of Harper's PID-file race gets an ExistingProcessWrapper back instead
		// of a ChildProcess: an EventEmitter carrying pid, kill(), unref(), and an 'exit'
		// event, with no stdio and no spawnargs. Its 1Hz liveness interval is not unref'd,
		// so a thread that joined an existing process never goes idle unless it unrefs.
		const adopted = !Array.isArray((child as unknown as { spawnargs?: string[] }).spawnargs);
		if (adopted) {
			logger.info(
				`${processName} is already running on this node (pid=${child.pid}); this ` +
					`thread joined the existing process instead of starting a second one.`
			);
			child.unref();
		} else {
			logger.info(`${processName} child process started (pid=${child.pid})`);

			// Attached before the wait below, so a child that dies while the receiver is
			// still coming up is reported by onExit rather than by the bind deadline.
			child.on('exit', (code, signal) => {
				void onExit(kind, processName, code, signal, watch);
			});

			child.on('error', (error: Error) => {
				// Asynchronous spawn failures only: ENOENT, EACCES, and similar. Harper's
				// allowlist rejection is not one of these; createSpawn throws synchronously
				// before any child exists, so that case lands in the catch below.
				logger.error(`Failed to execute ${processName}: ${error.message}`);
				logger.error(describeSpawnFailure(error, binaryPath) ?? `Binary path: ${binaryPath}`);
				process.exit(1);
			});
		}

		// "Started" is not the claim worth making about a trace-agent; "bound" is.
		if (watch) {
			await requireReceiverBound(watch, child, { processName, args, binaryPath, ownsChild: !adopted });
		}
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
		} else if (resolvedBinaryPath && describeSpawnFailure(error, resolvedBinaryPath)) {
			// Windows reports some of these synchronously; POSIX does not.
			logger.error(describeSpawnFailure(error, resolvedBinaryPath)!);
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
	signal: NodeJS.Signals | null,
	watch?: ReceiverWatch
): Promise<void> {
	if (signal) {
		if (GRACEFUL_SIGNALS.has(signal)) {
			logger.warn(`${processName} terminated by signal ${signal}`);
			process.exit(0);
		}
		logger.error(
			`${processName} was killed by ${signal}. The OOM killer sends SIGKILL, and ` +
				`SIGSEGV/SIGABRT/SIGBUS are crashes; none of them is a shutdown, so this exits ` +
				`non-zero to let whatever supervises this process restart the agent.`
		);
		// The shell convention. os.constants covers every signal Node can report; the
		// fallback is there because process.exit(NaN) exits 0, which is the bug being fixed.
		const signum = os.constants.signals[signal];
		process.exit(signum ? 128 + signum : 1);
	}

	const port = watch?.port ?? receiverPort();

	// A trace-agent that exits rc=1 because the receiver port was already taken is benign:
	// the port is served, so APM works. But rc=1 is also what a misconfigured agent
	// returns, and a bare port check cannot tell the two apart, so an unrelated listener
	// would turn every startup failure into a reported success. Require a healthy /info
	// response, which only a real trace-agent serves.
	if (kind === 'trace' && code === 1 && port !== RECEIVER_DISABLED && (await isTraceReceiverHealthy(port))) {
		logger.info(
			`${processName} exited immediately while a healthy trace-agent receiver ` +
				`answered on 127.0.0.1:${port}, which means another instance already owns ` +
				`the port (EADDRINUSE). Treating this as already-running.`
		);
		process.exit(0);
	}

	if (watch && !watch.bound) {
		logger.error(
			`${processName} exited with code ${code} without ever answering /info on ` +
				`127.0.0.1:${port}, so it never served the APM receiver and every span dd-trace ` +
				`produced while it ran was dropped. Measured against 7.82.1, a trace-agent whose ` +
				`apm_config.enabled is false exits 0 on exactly this path, which is why the exit ` +
				`code alone cannot be read as a successful launch here.`
		);
		process.exit(code || 1);
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
	describeSpawnFailure,
	receiverPort,
	isRunSubcommand,
	isTraceReceiverHealthy,
	waitForReceiver,
	onExit,
};
