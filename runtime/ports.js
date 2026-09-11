// The five numbers this component and the agents have to agree on.
//
// Two halves with different owners. `resolvePort` is generic and belongs with the guard: any component
// reading a port out of the environment wants exactly this refusal. The table under it is Datadog's, and
// the variable names are theirs, so it stays here.

/**
 * A port from the environment, or the fallback, never a number nobody wrote.
 *
 * parseInt reads "8126tcp" as 8126, so this matches the whole string instead. `0` is kept rather than
 * rejected because it is upstream's spelling for "serve no endpoint here".
 *
 * @param {string} name
 * @param {number} fallback
 * @param {import('@deliciousmonster/harper-process-guard').Log} log
 */
export function resolvePort(name, fallback, log) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const trimmed = raw.trim();
	if (trimmed === "0") return 0;
	const parsed = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (parsed >= 1 && parsed <= 65535) return parsed;
	log.warn(
		`Datadog supervisor: ${name}="${raw}" is not a port in 1-65535. Using ${fallback}.`
	);
	return fallback;
}

/**
 * Read once per component instance, because every worker thread renders the config and probes the
 * endpoints from these numbers and a second reading could disagree with the first.
 *
 * @param {import('@deliciousmonster/harper-process-guard').Log} log
 */
export function resolvePorts(log) {
	return {
		receiver: resolvePort("DD_APM_RECEIVER_PORT", 8126, log),
		expvar: resolvePort("DD_EXPVAR_PORT", 5000, log),
		debug: resolvePort("DD_APM_DEBUG_PORT", 5012, log),
		// Pinned for the same reason as expvar: this component sends its own process series here, so the
		// sender and the listener come from one number rather than two defaults that can drift apart.
		dogstatsd: resolvePort("DD_DOGSTATSD_PORT", 8125, log),
		// process-agent's own expvar, separate from the core agent's. Without it nothing on this node can
		// say whether the connections check is running, which is the only reason that binary is here.
		processExpvar: resolvePort("DD_PROCESS_CONFIG_EXPVAR_PORT", 6062, log),
	};
}
