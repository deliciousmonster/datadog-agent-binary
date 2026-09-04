// A second, independent proof of MOD-16's equivalence property, portable to a plain CI runner: unlike
// test/live/harness.js's DIMENSIONS table, nothing here needs a real (and, for one row, locally-patched)
// Harper. component.js's nativeScope stands in for Harper's own sidecar; the only things that are real
// are the two agent binaries this repo builds and the spans this file sends them. Deliberately independent
// of test/live/ - this file imports nothing from there - so a future change to that local-only layer can
// never silently change what this one proves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
	loadComponent,
	nativeScope,
	REPO_ROOT,
	withRealBinaries,
} from "../support/component.js";
import { withEnvs, withTempDir } from "../support/sandbox.js";
import { findFreePort } from "../support/loopback.js";

// prepareRuntime nests the runtime tree under the component's own directory name; the guard's pid
// lock directory sits under that, same as test/component/supervisor-start.test.js's own layout.
const APP_NAME = path.basename(REPO_ROOT);
const REAPER = "datadog-agent-reaper";
const AGENT_NAMES = ["datadog-trace-agent", "datadog-agent"];

const SPAN_COUNT = 5;
// The concentrator only leaves "idle" once it has built a stats bucket from what the receiver counted,
// on its own fixed interval; test/live/harper-boot.test.js polls the same field and needs the same room.
const DELIVERY_DEADLINE_MS = 60_000;

// Syntactically valid, not real: same reasoning as test/live/harness.js's own FAKE_API_KEY. A wrong
// key still makes the trace-agent build and count real payloads before the intake refuses them.
const FAKE_API_KEY = "0".repeat(32);

async function freshPorts() {
	return {
		receiver: await findFreePort(),
		expvar: await findFreePort(),
		debug: await findFreePort(),
		dogstatsd: await findFreePort(),
		cmd: await findFreePort(),
	};
}

// dd-trace initialises once per process, so this runs in a throwaway child - the same shape as
// test/live/harness.js's own TRAFFIC_SCRIPT, kept as this file's own copy rather than an import so
// this proof never depends on that local-only file.
const TRAFFIC_SCRIPT = `
const tracer = require('dd-trace').init({ startupLogs: false, flushInterval: 0 });
const count = Number(process.env.SPAN_COUNT);
for (let i = 0; i < count; i++) {
	const span = tracer.startSpan('supervision-equivalence.span', { tags: { 'span.iteration': i } });
	span.finish();
}
`;

/** Real spans, from a real child process, into the real receiver at `receiverPort`. Blocks until flushed. */
function driveTraffic(receiverPort, count) {
	execFileSync(process.execPath, ["-e", TRAFFIC_SCRIPT], {
		cwd: REPO_ROOT,
		timeout: 20_000,
		env: {
			...process.env,
			SPAN_COUNT: String(count),
			DD_TRACE_AGENT_URL: `http://127.0.0.1:${receiverPort}`,
			DD_TRACE_STARTUP_LOGS: "false",
			DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
			DD_REMOTE_CONFIGURATION_ENABLED: "false",
			DD_CRASHTRACKING_ENABLED: "false",
		},
	});
}

const lockFile = (pidDir, name) => path.join(pidDir, `${name}.pid`);

/** The pid a guard lock records, or null. Line 1 is the pid; a host reading only that still reads it. */
function lockedPid(pidDir, name) {
	try {
		const first = fs
			.readFileSync(lockFile(pidDir, name), "utf-8")
			.split("\n")[0];
		return Number.parseInt(first, 10);
	} catch {
		return null;
	}
}

// SIGTERM, not SIGKILL: the guard reads a signalled stop as deliberate and releases its lock instead
// of restarting, so teardown here cannot race the supervision this file just started.
function halt(pid) {
	if (!Number.isInteger(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
}

async function waitForLocksCleared(pidDir, names) {
	for (let i = 0; i < 300; i++) {
		if (names.every((name) => !fs.existsSync(lockFile(pidDir, name)))) return;
		await delay(10);
	}
}

/** Polls readSignal() until the receiver reports exactly `count` and the verdict has left "idle", or the deadline passes. */
async function waitForDeliveredCount(readSignal, count, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	let signal;
	while (Date.now() < deadline) {
		signal = await readSignal();
		if (
			signal?.receiver?.tracesReceived === count &&
			signal.verdict !== "idle"
		) {
			return signal.receiver.tracesReceived;
		}
		await delay(500);
	}
	return signal?.receiver?.tracesReceived;
}

/**
 * Boots resources.js against `makeScope()`, drives SPAN_COUNT real spans through the real trace-agent
 * it starts, and reads the delivered count back through the component's own readDeliverySignal. Every
 * real process this starts - both agents, and the guard's reaper where there is one - is stopped
 * before this returns.
 */
async function bootDriveAndRead(makeScope) {
	return withTempDir("dd-equivalence-", async (root) => {
		const ports = await freshPorts();
		const scope = makeScope();
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

					driveTraffic(ports.receiver, SPAN_COUNT);
					const delivered = await waitForDeliveredCount(
						() => component.readDeliverySignal(),
						SPAN_COUNT,
						DELIVERY_DEADLINE_MS
					);

					return { supervision: status.supervision, delivered };
				} finally {
					for (const child of scope.children ?? []) halt(child.pid);
					for (const entry of status?.processes ?? []) halt(entry.pid);
					if (status?.supervision === "guard") {
						const pidDir = path.join(root, "datadog", APP_NAME, "pids");
						halt(lockedPid(pidDir, REAPER));
						await waitForLocksCleared(pidDir, [...AGENT_NAMES, REAPER]);
					}
				}
			}
		);
	});
}

const ROWS = [
	{
		name: "harperSupervisor: native scope.processes (realistic fake Scope, real binaries)",
		makeScope: nativeScope,
		expectedSupervision: "harper",
	},
	{
		name: "guardSupervisor: bundled guard (no scope.processes, real binaries)",
		makeScope: () => ({}),
		expectedSupervision: "guard",
	},
];

// Filled in by each row's own test below, so the comparison test can read real delivered counts
// without booting the component a second time. A row whose own test failed leaves no entry, which the
// comparison test treats as its own failure rather than silently skipping it.
const deliveredByRow = new Map();

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
			deliveredByRow.set(row.name, delivered);
		});
	});
}

// MOD-16's acceptance bullet, proved without the locally-patched Harper test/live/harness.js's own row
// needs: N real spans against each supervision path must land N real traces on both.
test("MOD-16 (CI-portable): harperSupervisor and guardSupervisor deliver the same trace count for the same real span count", () => {
	const counts = ROWS.map((row) => {
		assert.ok(
			deliveredByRow.has(row.name),
			`"${row.name}" reported no delivered count; its own boot test above must pass before this comparison means anything`
		);
		return deliveredByRow.get(row.name);
	});

	assert.ok(
		counts.every((count) => count === counts[0]),
		`the same ${SPAN_COUNT} real spans produced different real trace counts across supervision paths: ${JSON.stringify(
			Object.fromEntries(ROWS.map((row, index) => [row.name, counts[index]]))
		)}`
	);
});
