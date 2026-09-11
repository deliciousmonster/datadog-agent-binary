// What one component instance knows about this worker thread, in one object rather than six closure
// variables, so the start path and the read path share it explicitly instead of by being written in the
// same file.
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
