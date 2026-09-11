// The two agents a node runs, and the loopback stand-ins their verifies read. Shared because the half
// that spawns for real and the half driven through Harper's recorded sidecar assert against the same node.

import path from "node:path";

import { REPO_ROOT } from "./component.js";
import { createStub, withServer } from "./loopback.js";
import { withEnvs, withTempDir } from "./sandbox.js";
import { createTlsStub } from "../fixtures/tls-stub.js";

// Harper's spawn names, which are also the PID-lock filenames. resources.js states them once; a second
// spelling here would be a second lock and a second agent per node.
export const TRACE_AGENT = "datadog-trace-agent";
export const CORE_AGENT = "datadog-agent";
export const REAPER = "datadog-agent-reaper";
export const BOTH_AGENTS = [TRACE_AGENT, CORE_AGENT];

// prepareRuntime nests the runtime tree under the component's own directory name.
export const APP_NAME = path.basename(REPO_ROOT);

export const SERVING = {
	endpoints: ["/v0.1/traces", "/v0.4/traces", "/v0.7/traces"],
};
export const CORE_EXPVAR = { aggregator: {}, forwarder: {}, pid: 4321 };

// What a recordingScope-driven start reports as the trace-agent's pid, in the shape the real trace-agent
// publishes it: a string. A number here would let a strict typeof test pass that the real agent fails.
const TRACE_DEBUG = { pid: "4321" };

/**
 * A receiver answering /info, a core expvar answering /debug/vars, the trace-agent's own expvar over TLS,
 * and the component pointed at all three.
 *
 * Each body may be a function rather than a value, because verification compares the pid on the lock against
 * the pid the agent reports: a body fixed before the spawn can only ever describe a mismatch.
 *
 * @param {{ info: object | (() => object), expvar: object | (() => object), debug?: object | (() => object) }} bodies
 * @param {(context: { root: string, receiver: number, expvarPort: number, debugPort: number }) => any} run
 */
export async function withAgentsAnswering(
	{ info, expvar, debug = TRACE_DEBUG },
	run
) {
	return withServer(createStub({ answers: "/info", body: info }), (receiver) =>
		withServer(
			createStub({ answers: "/debug/vars", body: expvar }),
			(expvarPort) =>
				withServer(
					createTlsStub({ answers: "/debug/vars", body: debug }),
					(debugPort) =>
						withTempDir("dd-runtime-", (root) =>
							withEnvs(
								{
									ROOTPATH: root,
									DD_APM_RECEIVER_PORT: String(receiver),
									DD_EXPVAR_PORT: String(expvarPort),
									DD_APM_DEBUG_PORT: String(debugPort),
									DD_API_KEY: "test-key-not-a-real-one",
								},
								() => run({ root, receiver, expvarPort, debugPort })
							)
						)
				)
		)
	);
}
