/**
 * What the trace-agent's APM receiver is, and how to tell whether one is really there.
 *
 * The launcher in src/agent-launcher.ts and the component supervisor in
 * example/dd-supervisor.js both have to answer that before either can claim APM works, and
 * they used to answer it with two copies of this code. The copies drifted. Nothing here
 * logs: the two callers write to different sinks, and a warning that lands on this
 * package's console never reaches hdb.log.
 *
 * The verdicts stay with the callers. One exits the process, the other records a field and
 * lets a database node carry on, and those policies are supposed to differ.
 */

/** `apm_config.receiver_port` default. dd-trace dials the same one with no configuration. */
export const DEFAULT_RECEIVER_PORT = 8126;

/** `apm_config.receiver_port: 0` is upstream's spelling for "serve no HTTP receiver". */
export const RECEIVER_DISABLED = 0;

/**
 * How long a freshly spawned trace-agent gets to answer /info before its absence is
 * reported. Generous on purpose: the receiver check in .github/workflows/build-verify.yml
 * already treats 30s as the cold-start bound, and a deadline that fires early would refuse
 * a launch that was about to work.
 */
export const RECEIVER_BIND_TIMEOUT_MS = 30_000;

const RECEIVER_POLL_INTERVAL_MS = 250;

/** Long enough for a loopback round trip against an agent that is still starting. */
const RECEIVER_PROBE_TIMEOUT_MS = 1000;

/**
 * The receiver being off is a configuration, so this is a warning rather than a failure,
 * and it is one string because the launcher and the supervisor both say it. An operator
 * who meets two spellings of the same condition has to work out whether they mean
 * different things.
 */
export const RECEIVER_DISABLED_WARNING =
	`apm_config.receiver_port is 0 (DD_APM_RECEIVER_PORT), which turns the trace-agent's HTTP ` +
	`receiver off. Nothing will listen on 127.0.0.1:${DEFAULT_RECEIVER_PORT}, so dd-trace ` +
	`drops every span unless it has been pointed at a Unix socket.`;

/**
 * Port the trace-agent binds, from the environment override of `apm_config.receiver_port`.
 *
 * Parsed rather than coerced: `Number('banana')` is NaN, and the supervisor writes this
 * value straight into a generated datadog.yaml, where `receiver_port: NaN` is unreadable.
 * `0` is returned as itself, because upstream reads it as "serve no HTTP receiver" (the
 * UDS-only setup) and rewriting it to 8126 would make every probe here interrogate a port
 * the agent was told not to bind. Any other unparseable value is a typo, and the fallback
 * must not be taken in silence: the agent reads the same variable and will not resolve it
 * the same way, which is how a caller comes to probe one port while the receiver binds
 * another.
 *
 * `warning` is returned rather than logged so the caller decides where it lands.
 */
export function resolveReceiverPort(): { port: number; warning?: string } {
	const raw = process.env.DD_APM_RECEIVER_PORT;
	if (!raw) return { port: DEFAULT_RECEIVER_PORT };
	// The raw string, not the parsed value: parseInt("0abc") is also 0, and that is a
	// typo rather than a request to turn the receiver off.
	if (raw.trim() === '0') return { port: RECEIVER_DISABLED };
	const parsed = Number.parseInt(raw, 10);
	if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return { port: parsed };
	return {
		port: DEFAULT_RECEIVER_PORT,
		warning:
			`DD_APM_RECEIVER_PORT="${raw}" is not a port in 1-65535. Falling back to ` +
			`${DEFAULT_RECEIVER_PORT}, the port dd-trace dials, but the agent reads the same ` +
			`variable and will not resolve it the same way. Fix or unset it.`,
	};
}

/**
 * True if whatever answers this port advertises the endpoint dd-trace posts spans to.
 *
 * The advertised endpoint is the whole point, and the name says so because the cheaper
 * checks are the trap. A bare TCP connect is satisfied by any leftover socket or container
 * port forward, and a 200 from an arbitrary path is satisfied by any health-check stub;
 * reading either as "APM is already handled" reproduces the exact failure this package
 * fixes. `/info` is served only by the trace-agent and lists the endpoints it accepts.
 */
export async function receiverAdvertisesTraces(port: number, timeoutMs = RECEIVER_PROBE_TIMEOUT_MS): Promise<boolean> {
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
 * Poll until the receiver advertises /traces, or the deadline passes.
 *
 * @param giveUp asked between probes, and only after a probe has failed, so an agent that
 *   binds and then dies still counts as having served the port. A caller that survives the
 *   agent passes the agent's liveness here: nothing binds after the process is gone, and
 *   sitting out the rest of the deadline only delays a report its exit handler already made.
 *   Named for what it does rather than `abort`, which in a file using AbortSignal would
 *   read as one.
 */
export async function waitForReceiver(
	port: number,
	{ timeoutMs = RECEIVER_BIND_TIMEOUT_MS, giveUp }: { timeoutMs?: number; giveUp?: () => boolean } = {}
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await receiverAdvertisesTraces(port)) return true;
		if (giveUp?.() || Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, RECEIVER_POLL_INTERVAL_MS));
	}
}

/**
 * Why a receiver that never answered matters, in the terms an operator can act on.
 *
 * Neither caller can shorten this. "The agent did not bind" is not actionable, and the
 * reason it is not is that every other signal says the launch worked. Both used to carry
 * their own wording of it, which is the drift this module exists to end.
 *
 * @param subject how the caller names the process in the rest of its own output.
 * @param configPath the datadog.yaml the agent reads, as the caller understands it.
 * @param logPath where the agent writes its own log, when the caller put it somewhere it
 *   can name.
 */
export function describeUnboundReceiver({
	subject,
	pid,
	port,
	configPath,
	logPath,
	timeoutMs = RECEIVER_BIND_TIMEOUT_MS,
}: {
	subject: string;
	pid?: number;
	port: number;
	configPath: string;
	logPath?: string;
	timeoutMs?: number;
}): string {
	return (
		`${subject}${pid === undefined ? '' : ` (pid ${pid})`} is running but nothing answered ` +
		`the trace-agent /info endpoint on 127.0.0.1:${port} within ${timeoutMs / 1000}s, so ` +
		`dd-trace has nowhere to send spans. It reports a successful flush either way, which is ` +
		`why an empty APM view is the only symptom this produces on its own. Check ` +
		`apm_config.enabled in ${configPath}, and DD_APM_ENABLED=${process.env.DD_APM_ENABLED ?? '(unset)'}, ` +
		`which overrides it. Then read ${logPath ?? "the agent's own log"}.`
	);
}
