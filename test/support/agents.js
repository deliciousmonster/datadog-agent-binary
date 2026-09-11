// The two agents a node runs, and the loopback stand-ins their verifies read. Shared because the half
// that spawns for real and the half driven through Harper's recorded sidecar assert against the same node.

import path from "node:path";

import { agentsFor, REAPER_NAME } from "../../runtime/datadog.js";
import { REPO_ROOT } from "./component.js";
import { createStub, withServer } from "./loopback.js";
import { withEnvs, withTempDir } from "./sandbox.js";
import { createTlsStub } from "../fixtures/tls-stub.js";

// Harper's spawn names, which are also the PID-lock filenames.
const lockName = (shipsAs) => agentsFor([shipsAs], { receiver: 0 })[0].name;

export const TRACE_AGENT = lockName("trace-agent");
export const CORE_AGENT = lockName("datadog-agent");
export const REAPER = REAPER_NAME;
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
 * A receiver answering /info, a core expvar answering /debug/vars, the trace-agent's own expvar over TLS, and
 * the component pointed at all three.
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
