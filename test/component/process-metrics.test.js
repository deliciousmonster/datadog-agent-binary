// `system.processes.*` is the Python `process` integration and this build ships no Python. Live Processes is
// Go and running (83 processes on the soak node), but it publishes to the Processes intake: no `process.*` or
// `system.*` metric name is compiled into the shipped binary, so nothing it collects is queryable or
// alertable. This module makes a named series that is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	aggregate,
	dogstatsdLines,
	processSeries,
	readProcess,
	selfProcess,
} from "../../runtime/process-metrics.js";

const status = (rssKb, threads) =>
	`Name:\tnode\nState:\tS (sleeping)\nThreads:\t${threads}\nVmRSS:\t${rssKb} kB\nVmSize:\t9999 kB\n`;

describe("reading one process", () => {
	it("reads resident bytes and threads out of /proc on linux", () => {
		const got = readProcess(4242, "linux", () => status(2048, 7));
		assert.deepEqual(got, { rssBytes: 2048 * 1024, threads: 7 });
	});

	it("NEGATIVE: answers null off linux rather than guessing", () => {
		// There is no /proc on macOS or Windows, and the alternatives are spawning `ps` on a schedule, which
		// Harper's constrained spawn would make an operator allowlist, or a native addon, which would end the
		// package's no-install-scripts property. Absent beats wrong.
		for (const platform of ["darwin", "win32", "freebsd"])
			assert.equal(
				readProcess(4242, platform, () => status(2048, 7)),
				null
			);
	});

	it("NEGATIVE: answers null when the process went away mid-read", () => {
		const gone = () => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		};
		assert.equal(readProcess(4242, "linux", gone), null);
	});

	it("NEGATIVE: answers null for a status with no VmRSS, rather than reporting zero", () => {
		// A kernel thread has no VmRSS. Reporting 0 would drag every average down.
		assert.equal(
			readProcess(2, "linux", () => "Name:\tkthreadd\nThreads:\t1\n"),
			null
		);
	});

	it("NEGATIVE: refuses a pid that is not a positive integer", () => {
		for (const bad of [0, -1, 1.5, NaN, undefined, null, "7"])
			assert.equal(
				readProcess(bad, "linux", () => status(1, 1)),
				null
			);
	});

	it("reads this process without /proc at all, which is what covers macOS and Windows", () => {
		const got = selfProcess();
		assert.ok(got.rssBytes > 0, "a live Node process has resident memory");
		assert.equal(typeof got.rssBytes, "number");
	});
});

describe("aggregating a named group", () => {
	const s = (rss, threads = 1) => ({ rssBytes: rss, threads });

	it("publishes the sum, mean and extremes the Python check publishes", () => {
		const got = aggregate([s(100), s(200), s(300)]);
		assert.equal(got.number, 3);
		assert.equal(got["mem.rss"], 600);
		assert.equal(got["mem.rss.avg"], 200);
		assert.equal(got["mem.rss.max"], 300);
		assert.equal(got["mem.rss.min"], 100);
	});

	it("counts what it measured, not what it was asked about", () => {
		// A supervised process this platform cannot read is absent from the series rather than a zero, so a
		// monitor sees no data instead of a floor that looks like a healthy reading.
		const got = aggregate([s(100), null, s(300)]);
		assert.equal(got.number, 2);
		assert.equal(got["mem.rss"], 400);
		assert.equal(
			got["mem.rss.min"],
			100,
			"the null must not become a minimum of 0"
		);
	});

	it("NEGATIVE: emits only a count when nothing could be measured", () => {
		const got = aggregate([null, null]);
		assert.deepEqual(got, { number: 0 });
	});

	it("sums threads across the group", () => {
		assert.equal(aggregate([s(1, 4), s(1, 6)]).threads, 10);
	});
});

describe("the wire form", () => {
	it("writes gauges, because every field is a level", () => {
		// A counter would be wrong across a restart, which this node does on purpose several times an hour.
		const lines = dogstatsdLines("harper.processes", {
			number: 2,
			"mem.rss": 40,
		});
		assert.deepEqual(lines, [
			"harper.processes.number:2|g",
			"harper.processes.mem.rss:40|g",
		]);
	});

	it("sorts tags so one reading is one series", () => {
		const [line] = dogstatsdLines("p", { n: 1 }, { z: "last", a: "first" });
		assert.equal(line, "p.n:1|g|#a:first,z:last");
	});

	it("NEGATIVE: drops empty tags rather than emitting a bare colon", () => {
		const [line] = dogstatsdLines(
			"p",
			{ n: 1 },
			{ a: "x", b: "", c: undefined }
		);
		assert.equal(line, "p.n:1|g|#a:x");
	});

	it("NEGATIVE: neutralises the characters that would split a packet", () => {
		const [line] = dogstatsdLines("p", { n: 1 }, { a: "one|two,three#four" });
		assert.equal(line, "p.n:1|g|#a:one_two_three_four");
	});

	it("NEGATIVE: drops a non-finite value rather than writing NaN on the wire", () => {
		assert.deepEqual(dogstatsdLines("p", { a: NaN, b: Infinity, c: 3 }), [
			"p.c:3|g",
		]);
	});
});

describe("a series for one supervised group", () => {
	it("tags the group and reports how much of it it could measure", () => {
		const got = processSeries([{ name: "self", self: true }], {
			group: "harper",
		});
		assert.equal(got.asked, 1);
		assert.equal(got.measured, 1);
		assert.ok(got.lines.some((l) => l.includes("#process_group:harper")));
	});

	it("NEGATIVE: off linux a pid-based member measures nothing and says so", () => {
		const got = processSeries([{ name: "core", pid: 4242 }], {
			group: "agents",
			platform: "darwin",
		});
		assert.equal(got.asked, 1);
		assert.equal(got.measured, 0);
		assert.deepEqual(got.metrics, { number: 0 });
		assert.deepEqual(
			got.lines,
			["harper.processes.number:0|g|#process_group:agents"],
			"the count still ships, so a dashboard shows zero measured rather than nothing at all"
		);
	});
});
