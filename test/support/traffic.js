// Real spans, from a throwaway child process, into a real trace-agent receiver. Shared by
// test/binaries/supervision-equivalence.test.js and test/live/harness.js, which differ only in env var and span naming, not in the mechanism.

import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./generator.js";

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
