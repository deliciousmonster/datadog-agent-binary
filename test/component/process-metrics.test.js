// `system.processes.*` is the Python `process` integration and this build ships no Python. Live Processes is
// Go and running (83 processes on the soak node), but it publishes to the Processes intake: no `process.*` or
// `system.*` metric name is compiled into the shipped binary, so nothing it collects is queryable or
// alertable. This module makes a named series that is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	aggregate,
	applyPatterns,
	dogstatsdLines,
	processSeries,
	readProcess,
	selfProcess,
	settings,
} from "../../runtime/process-metrics.js";
import { loadComponent } from "../support/component.js";

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

describe("whether it sends at all", () => {
	// A boolean, not the presence of a config file. Datadog gates an integration on conf.d/<check>.d/ because
	// the agent cannot know what to monitor; this measures processes the component spawned, so it knows its
	// own subject. That puts it with apm_config.enabled and process_config.process_collection.enabled, both
	// of which this package already renders as booleans.
	it("is on when nothing says otherwise, because installing the plugin is the ask", () => {
		assert.equal(settings({}).enabled, true);
	});

	it("is off only for an explicit falsehood", () => {
		for (const off of ["false", "FALSE", "0", "no", "off", "Off"])
			assert.equal(
				settings({ DD_HARPER_PROCESS_METRICS_ENABLED: off }).enabled,
				false,
				off
			);
	});

	it("NEGATIVE: a typo leaves it on rather than silently stopping the data", () => {
		for (const typo of ["flase", "", "true", "yes", "1"])
			assert.equal(
				settings({ DD_HARPER_PROCESS_METRICS_ENABLED: typo }).enabled,
				true,
				typo
			);
	});

	it("carries Datadog's own default cadence, so the number an operator knows still applies", () => {
		assert.equal(settings({}).intervalSeconds, 15);
		assert.equal(
			settings({ DD_HARPER_PROCESS_METRICS_INTERVAL: "60" }).intervalSeconds,
			60
		);
	});

	it("NEGATIVE: refuses a cadence that is not a positive number", () => {
		for (const bad of ["0", "-5", "soon", ""])
			assert.equal(
				settings({ DD_HARPER_PROCESS_METRICS_INTERVAL: bad }).intervalSeconds,
				15,
				bad
			);
	});
});

describe("metric_patterns, with Datadog's semantics", () => {
	const all = { number: 1, "mem.rss": 2, "mem.rss.avg": 3, threads: 4 };

	it("include narrows to what matches", () => {
		assert.deepEqual(applyPatterns(all, { include: ["^mem\\."] }), {
			"mem.rss": 2,
			"mem.rss.avg": 3,
		});
	});

	it("exclude removes, and beats include on overlap", () => {
		// Datadog's rule: "Metrics defined in `exclude` will take precedence in case of overlap."
		assert.deepEqual(
			applyPatterns(all, { include: ["^mem\\."], exclude: ["avg$"] }),
			{ "mem.rss": 2 }
		);
	});

	it("NEGATIVE: no patterns means everything, not nothing", () => {
		assert.deepEqual(applyPatterns(all, {}), all);
		assert.deepEqual(applyPatterns(all), all);
	});

	it("NEGATIVE: a malformed pattern matches nothing rather than throwing a status read", () => {
		assert.deepEqual(applyPatterns(all, { exclude: ["([unclosed"] }), all);
		assert.deepEqual(applyPatterns(all, { include: ["([unclosed"] }), {});
	});

	it("the series honours patterns end to end, which is where the cost is controlled", () => {
		const got = processSeries([{ name: "self", self: true }], {
			group: "harper",
			exclude: ["\\.(avg|max|min)$", "^threads$"],
		});
		assert.deepEqual(Object.keys(got.metrics).sort(), ["mem.rss", "number"]);
	});
});

describe("where the settings are visible", () => {
	// Four patterns exist in this package: env rendered into datadog.yaml (the ports), env deliberately not
	// rendered (DD_API_KEY, DD_SITE), yaml-only values the plugin decides (target_traces_per_second), and
	// these, which only the plugin reads. The agent never sees them, so datadog.yaml would be the wrong
	// place: its header says it is the agent's generated config, and a key the agent ignores reads as a
	// setting that silently does nothing. The plugin's own endpoint is where the plugin reports itself.
	it("the status endpoint carries what this component resolved", async () => {
		const { DatadogStatus } = await loadComponent();
		const status = await DatadogStatus.get();
		assert.equal(typeof status.processMetrics, "object");
		assert.equal(status.processMetrics.enabled, true);
		assert.equal(status.processMetrics.intervalSeconds, 15);
		assert.deepEqual(status.processMetrics.exclude, []);
	});

	it("NEGATIVE: datadog.yaml carries none of these keys, because the agent would ignore them", async () => {
		const { prepareRuntime } = await loadComponent();
		const rendered = Object.values(prepareRuntime().configFiles).join("\n");
		for (const key of [
			"DD_HARPER_PROCESS_METRICS_ENABLED",
			"processMetrics",
			"harper_process_metrics",
		])
			assert.ok(
				!new RegExp(`^\\s*${key}\\s*:`, "m").test(rendered),
				`${key} must not be rendered as an agent setting`
			);
	});
});
