// A second, independent proof of MOD-16's equivalence property, portable to a plain CI runner: unlike
// test/live/harness.js's DIMENSIONS table, nothing here needs a real (and, for one row, locally-patched)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
	halt,
	loadComponent,
	lockedPid,
	nativeScope,
	REPO_ROOT,
	waitForLocksCleared,
	withRealBinaries,
} from "../support/component.js";
import { BOTH_AGENTS, REAPER } from "../support/agents.js";
import { withEnvs, withTempDir } from "../support/sandbox.js";
import { freshPorts } from "../support/loopback.js";
import {
	FAKE_API_KEY,
	driveTraffic,
	waitForDeliveredCount,
} from "../support/traffic.js";

// prepareRuntime nests the runtime tree under the component's own directory name; the guard's pid
// lock directory sits under that, same as test/unit/supervisor-start.test.js's own layout.
const APP_NAME = path.basename(REPO_ROOT);

const SPAN_COUNT = 5;
// The concentrator only leaves "idle" once it has built a stats bucket from what the receiver counted,
// on its own fixed interval; test/live/harper-boot.test.js polls the same field and needs the same room.
const DELIVERY_DEADLINE_MS = 60_000;

// The API key, the traffic-driving mechanism and the delivery poll all live in support/traffic.js,
// shared with test/live/harness.js; only the env var and span naming below are this file's own.
const SPAN_SCRIPT = {
	envVar: "SPAN_COUNT",
	spanName: "supervision-equivalence.span",
	tagKey: "span.iteration",
};

/**
 * Boots resources.js against `makeScope(root)`, drives SPAN_COUNT real spans through the real trace-agent it
 * starts, and reads the delivered count back through the component's own readDeliverySignal.
 */
async function bootDriveAndRead(makeScope) {
	return withTempDir("dd-equivalence-", async (root) => {
		const ports = await freshPorts();
		const scope = makeScope(root);
		return withEnvs(
			{
				ROOTPATH: root,
				DD_API_KEY: FAKE_API_KEY,
				DD_SITE: "datadoghq.com",
				DD_APM_RECEIVER_PORT: String(ports.receiver),
				DD_EXPVAR_PORT: String(ports.expvar),
				DD_APM_DEBUG_PORT: String(ports.debug),
				DD_DOGSTATSD_PORT: String(ports.dogstatsd),
				DD_CMD_PORT: String(ports.cmd),
			},
			async () => {
				const component = await loadComponent();
				let status;
				try {
					component.handleApplication(scope);
					status = await component.DatadogStatus.get();

					const trace = status.processes.find(
						(entry) => entry.kind === "trace"
					);
					assert.ok(
						trace?.verified,
						`the trace-agent did not verify: ${trace?.verifyDetail ?? JSON.stringify(trace)}`
					);

					driveTraffic(ports.receiver, SPAN_COUNT, SPAN_SCRIPT);
					const signal = await waitForDeliveredCount(
						() => component.readDeliverySignal(),
						SPAN_COUNT,
						DELIVERY_DEADLINE_MS
					);

					return {
						supervision: status.supervision,
						delivered: signal?.receiver?.tracesReceived,
					};
				} finally {
					// For the native row, status.processes carries the exact pids already in
					// scope.children; haltedPids keeps that overlap from a second, redundant SIGTERM.
					const haltedPids = new Set();
					for (const child of scope.children ?? []) {
						halt(child.pid);
						haltedPids.add(child.pid);
					}
					for (const entry of status?.processes ?? []) {
						if (!haltedPids.has(entry.pid)) halt(entry.pid);
					}
					if (status?.supervision === "guard") {
						const pidDir = path.join(root, "datadog", APP_NAME, "pids");
						halt(lockedPid(pidDir, REAPER));
						await waitForLocksCleared(pidDir, [...BOTH_AGENTS, REAPER]);
					}
				}
			}
		);
	});
}

const ROWS = [
	{
		name: "harperSupervisor: native scope.processes (realistic fake Scope, real binaries)",
		// logDir: the same per-boot root bootDriveAndRead already tears down, so each agent's log
		// lands and is cleaned up alongside everything else that boot wrote.
		makeScope: (root) => nativeScope({ logDir: root }),
		expectedSupervision: "harper",
	},
	{
		name: "guardSupervisor: bundled guard (no scope.processes, real binaries)",
		makeScope: () => ({}),
		expectedSupervision: "guard",
	},
];

// Deliberately skips hideBuildTree: that precaution catches a binary still linked to its build
// tree, a different property from the supervision equivalence this file proves.
for (const row of ROWS) {
	test(`${row.name}: ${SPAN_COUNT} real spans land in the real trace-agent and are read back via readDeliverySignal`, async () => {
		await withRealBinaries(async () => {
			const { supervision, delivered } = await bootDriveAndRead(row.makeScope);
			assert.equal(
				supervision,
				row.expectedSupervision,
				`${row.name} ran through "${supervision}" supervision, not the expected "${row.expectedSupervision}"`
			);
			assert.equal(
				delivered,
				SPAN_COUNT,
				`${row.name}: the real trace-agent reported ${delivered} delivered traces, not the ${SPAN_COUNT} spans this run actually sent`
			);
		});
	});
}
