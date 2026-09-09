// A reaper the guard started can die, and until currentReaper existed the status reported the boot state:
// chaos killed the reaper at 01:43 on 2026-09-09 and ten minutes later the endpoint still called it started,
// naming the pid that had been killed. The soak recorded that kill as recovered on the strength of it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { currentReaper, readGuardLock } from "../../runtime/supervisor.js";

const REAPER = "datadog-agent-reaper";
// A pid nothing holds. 2^22 is above every default pid_max, so this cannot race a real process.
const DEAD_PID = 2 ** 22 - 7;

/** The three-line shape the guard writes: pid, version, then the record carrying the argv. */
const lock = (dir, pid, argv, version = 7) =>
	writeFileSync(
		join(dir, `${REAPER}.pid`),
		`${pid}\n${version}\n${JSON.stringify({ token: "t", host: 1, argv })}`
	);

const bootState = { name: REAPER, started: true, adopted: false, pid: 888 };

describe("the reaper in the status", () => {
	let dir;
	let child;
	let childArgv;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "dd-reaper-status-"));
		childArgv = [process.execPath, "-e", "setInterval(function () {}, 1000)"];
		child = spawn(childArgv[0], childArgv.slice(1), { stdio: "ignore" });
		// ps and /proc only report the process once the exec has happened.
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (currentReaper(bootState, dir) !== undefined) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	});

	after(() => {
		child?.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports a reaper whose lock still identifies it, under the pid the lock names", () => {
		lock(dir, child.pid, childArgv);
		const now = currentReaper(bootState, dir);
		assert.equal(now.started, true);
		// The lock's pid, not the boot state's: another thread may have replaced the reaper this one started.
		assert.equal(now.pid, child.pid);
	});

	it("NEGATIVE: refuses to call a reaper started when its lock names a pid nothing holds", () => {
		lock(dir, DEAD_PID, childArgv);
		const now = currentReaper(bootState, dir);
		assert.equal(
			now.started,
			false,
			"a dead reaper must not be reported as started"
		);
		assert.equal(
			now.pid,
			undefined,
			"the dead pid must not be published as the reaper's"
		);
		assert.match(now.error, /nothing holds/);
		assert.match(now.error, /outlive it/);
	});

	it("NEGATIVE: refuses a live pid running something else", () => {
		lock(dir, child.pid, ["/nonexistent/reaper.js", "--host-pid", "1"]);
		const now = currentReaper(bootState, dir);
		assert.equal(now.started, false);
		assert.match(now.error, /running something else/);
	});

	it("NEGATIVE: refuses when there is no lock at all", () => {
		const empty = mkdtempSync(join(tmpdir(), "dd-reaper-empty-"));
		try {
			const now = currentReaper(bootState, empty);
			assert.equal(now.started, false);
			assert.match(now.error, /no lock for/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("keeps the boot state when no reaper was configured, and when the pid directory is unknown", () => {
		assert.equal(currentReaper(undefined, dir), undefined);
		assert.deepEqual(currentReaper(bootState, undefined), bootState);
	});

	describe("readGuardLock", () => {
		it("reads the pid, the version and the recorded argv", () => {
			lock(dir, 4242, ["node", "reaper.js"], 9);
			const held = readGuardLock(join(dir, `${REAPER}.pid`));
			assert.deepEqual(held, {
				pid: 4242,
				version: 9,
				argv: ["node", "reaper.js"],
			});
		});

		it("identifies nothing for a lock written before the argv record, rather than throwing", () => {
			writeFileSync(join(dir, `${REAPER}.pid`), "4242\n9");
			assert.deepEqual(readGuardLock(join(dir, `${REAPER}.pid`)).argv, []);
		});

		it("treats an unreadable or pidless lock as no lock", () => {
			assert.equal(readGuardLock(join(dir, "absent.pid")), undefined);
			writeFileSync(join(dir, `${REAPER}.pid`), "not a pid\n9\n[]");
			assert.equal(readGuardLock(join(dir, `${REAPER}.pid`)), undefined);
		});
	});
});
