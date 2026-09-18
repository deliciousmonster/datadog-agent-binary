// GET /DatadogStatus/ re-reads node state on every request, because a state built at boot describes a node
// that has since restarted. It did that re-read by reading the bundled guard's PID locks, and ran it on both
// supervision paths. Harper supervises through its own locks, in its own directory, in its own format, so on
// the native path the re-read found nothing and said so: a reaper confirmed alive by `ps` was published as
//
//   "reaper": { "started": false, "error": "no lock for harper-sidecar-reaper under <plugin pidDir>.
//               Nothing is reaping this node's processes ..." }
//
// The re-read exists for one thing the bundled guard does and Harper does not: build a state once and leave a
// copy behind. Harper mutates the state it published, so on that path there is nothing to refresh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createStatusResource } from "../../runtime/component.js";
import { withTempDir } from "../support/sandbox.js";

class StubResource {}

const REAPER = "datadog-agent-reaper";

/**
 * A status resource over one supervisor's published state, with no lock of its own anywhere.
 *
 * @param {string} supervision @param {string} pidDir
 * @param {{ reaper?: Record<string, any>, processes?: any[] }} [published]
 */
const statusOver = (supervision, pidDir, { reaper, processes = [] } = {}) =>
	createStatusResource({
		ResourceBase: StubResource,
		state: /** @type {any} */ ({
			supervisor: Promise.resolve({
				supervision,
				processes,
				...(reaper ? { reaper } : {}),
			}),
			pidDir,
			verifiers: new Map(),
		}),
		notStarted: { supervision, processes: [] },
		readDeliverySignal: async () => ({}),
	});

test("a native host's live reaper is published as it stands, not re-derived from a lock this package never wrote", () =>
	withTempDir("status-gate-", async (pidDir) => {
		// Alive, and the plugin's pid directory is empty: exactly the shape the defect needed
		const reaper = {
			name: REAPER,
			started: true,
			adopted: false,
			pid: process.pid,
			exited: false,
		};
		const body = await statusOver("harper", pidDir, { reaper }).get();

		assert.equal(
			body.reaper.started,
			true,
			"a live reaper was published as dead"
		);
		assert.equal(
			body.reaper.error,
			undefined,
			"and carried an invented diagnosis"
		);
		assert.equal(
			body.reaper.pid,
			process.pid,
			"with the pid dropped, nothing can find or kill it"
		);
		assert.equal(
			body.reaper,
			reaper,
			"the host mutates this object; a copy freezes the status at boot"
		);
	}));

test("the bundled guard's reaper is still re-read, because that one is a copy taken at boot", () =>
	withTempDir("status-gate-", async (pidDir) => {
		// The same boot state, on the path that leaves a copy behind and has no lock to back it
		const reaper = {
			name: REAPER,
			started: true,
			adopted: false,
			pid: process.pid,
		};
		const body = await statusOver("guard", pidDir, { reaper }).get();

		assert.equal(
			body.reaper.started,
			false,
			"an unbacked guard reaper must not keep reading started"
		);
		assert.match(body.reaper.error, /no lock for datadog-agent-reaper/);
		assert.match(body.reaper.error, /Nothing is reaping this node's processes/);
	}));

test("a native host's unstarted process is reported as the host left it, with no lock consulted", () =>
	withTempDir("status-gate-", async (pidDir) => {
		// A lock that WOULD adopt, and is asserted to below on the guard path: same name, a live pid, an
		// argv that identifies. On the native path it is not this package's lock to read, whatever it says.
		writeFileSync(
			join(pidDir, "datadog-agent.pid"),
			`${process.pid}\n7\n${JSON.stringify({ token: "t", host: 1, argv: [process.execPath] })}`
		);
		const refused = {
			name: "datadog-agent",
			started: false,
			adopted: false,
			error: "harper refused it",
		};
		const body = await statusOver("harper", pidDir, {
			processes: [refused],
		}).get();

		assert.equal(
			body.processes[0].started,
			false,
			"a foreign lock adopted a process on the native path"
		);
		assert.equal(
			body.processes[0].error,
			"harper refused it",
			"and overwrote the host's own reason"
		);
	}));

test("which is not a way of switching the adoption off: the guard's own path still adopts", () =>
	withTempDir("status-gate-", async (pidDir) => {
		const argv = [process.execPath];
		writeFileSync(
			join(pidDir, "datadog-agent.pid"),
			`${process.pid}\n7\n${JSON.stringify({ token: "t", host: 1, argv })}`
		);
		const refused = {
			name: "datadog-agent",
			started: false,
			adopted: false,
			error: "this thread was refused",
		};
		const body = await statusOver("guard", pidDir, {
			processes: [refused],
		}).get();

		assert.equal(
			body.processes[0].started,
			true,
			"the node has this agent under another thread"
		);
		assert.equal(body.processes[0].pid, process.pid);
		assert.equal(
			body.processes[0].refused,
			"this thread was refused",
			"kept as a diagnostic, not as health"
		);
	}));
