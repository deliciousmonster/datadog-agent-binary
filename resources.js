import { spawn } from "node:child_process";

import { datadog } from "./runtime/component.js";

// Harper compiles only this file, so the constrained `spawn` and the compartment globals are read here and
// handed down. A module that imports them itself may get the unconstrained ones.
export const {
	handleApplication,
	DatadogStatus,
	prepareRuntime,
	readDeliverySignal,
	AGENTS,
} = datadog({
	spawn,
	logger: typeof logger === "undefined" ? undefined : logger,
	Resource: typeof Resource === "undefined" ? undefined : Resource,
	// Each name is the binary's filename, in start order. The trace-agent comes first because it owns the
	// socket dd-trace is dialing. runtime/datadog.js says what each one is and when it runs.
	processes: [
		"trace-agent",
		"datadog-agent",
		"system-probe",
		"process-agent",
		"security-agent",
	],
});
