// Real delivery through a real trace-agent: the key that makes it count payloads, the spans a child
// process sends it, and the poll that reads the count back. Shared by test/binaries/supervision-equivalence.test.js,
// test/live/harness.js and test/binaries/smoke.js, which differ only in span naming, not in the mechanism.

import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { REPO_ROOT } from "./generator.js";

// Syntactically valid, not real. A wrong key still makes the trace-agent build and count real
// payloads before the intake refuses them; an unset key disables the forwarder and proves nothing.
export const FAKE_API_KEY = "0".repeat(32);

// dd-trace initialises once per process, so this always runs in a child. No explicit process.exit():
// flushInterval 0 posts on every export, and the in-flight POST needs the event loop kept alive to finish, not a settle delay standing in for it.
function trafficScript({ envVar, spanName, tagKey }) {
	return `
const tracer = require('dd-trace').init({ startupLogs: false, flushInterval: 0 });
const count = Number(process.env.${envVar});
for (let i = 0; i < count; i++) {
	const span = tracer.startSpan('${spanName}', { tags: { '${tagKey}': i } });
	span.finish();
}
`;
}

// Real spans, from a real child process, into the real receiver at `receiverPort`. Blocks until flushed;
// envVar/spanName/tagKey namespace the script so two callers never collide on the one env var a child reads.
export function driveTraffic(
	receiverPort,
	count,
	{ envVar, spanName, tagKey }
) {
	execFileSync(
		process.execPath,
		["-e", trafficScript({ envVar, spanName, tagKey })],
		{
			cwd: REPO_ROOT,
			timeout: 20_000,
			env: {
				...process.env,
				[envVar]: String(count),
				DD_TRACE_AGENT_URL: `http://127.0.0.1:${receiverPort}`,
				DD_TRACE_STARTUP_LOGS: "false",
				DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
				DD_REMOTE_CONFIGURATION_ENABLED: "false",
				DD_CRASHTRACKING_ENABLED: "false",
			},
		}
	);
}

const DELIVERY_POLL_MS = 500;

/**
 * Polls `readSignal` until the real receiver has reported exactly `count` traces and the verdict has
 * left "idle", or the deadline passes. The two are latched apart: the receiver snapshot shows the burst
 * within seconds and is reset by the agent, while the verdict waits on the first stats bucket, some
 * twenty seconds behind (measured 24s on a real node), and the snapshot can be gone by then. Demanding
 * both in one read passed or failed on that ordering. Returns the read that carried the count, with the
 * verdict from the read that moved; `undefined` only if `readSignal` never produced one.
 */
export async function waitForDeliveredCount(readSignal, count, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	let signal;
	let counted;
	let moved;
	while (Date.now() < deadline) {
		signal = await readSignal();
		if (signal?.receiver?.tracesReceived === count) counted = signal;
		if (signal?.verdict && signal.verdict !== "idle") moved = signal;
		if (counted && moved) {
			return { ...counted, verdict: moved.verdict, detail: moved.detail };
		}
		await delay(DELIVERY_POLL_MS);
	}
	return counted ?? signal;
}
