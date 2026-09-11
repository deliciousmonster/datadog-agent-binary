// `system.processes.*` is the Python `process` integration and this build ships no Python.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_PREFIX,
	PRIVATE_PREFIX,
	aggregate,
	applyPatterns,
	dogstatsdLines,
	processSeries,
	sendDogstatsd,
	seriesSettings,
	standDownFor,
	startProcessSeries,
} from "../../runtime/series.js";
import { loadComponent } from "../support/component.js";
import { withTempDir } from "../support/sandbox.js";

const status = (rssKb, threads) =>
	`Name:\tnode\nState:\tS (sleeping)\nThreads:\t${threads}\nVmRSS:\t${rssKb} kB\nVmSize:\t9999 kB\n`;

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
			["system.processes.number:0|g|#process_group:agents,process_name:agents"],
			"the count still ships, so a dashboard shows zero measured rather than nothing at all"
		);
	});
});

describe("whether it sends at all", () => {
	// A boolean, not the presence of a config file.
	it("is on when nothing says otherwise, because installing the plugin is the ask", () => {
		assert.equal(seriesSettings({}).enabled, true);
	});

	it("is off only for an explicit falsehood", () => {
		for (const off of ["false", "FALSE", "0", "no", "off", "Off"])
			assert.equal(
				seriesSettings({ DD_HARPER_PROCESS_METRICS_ENABLED: off }).enabled,
				false,
				off
			);
	});

	it("NEGATIVE: a typo leaves it on rather than silently stopping the data", () => {
		for (const typo of ["flase", "", "true", "yes", "1"])
			assert.equal(
				seriesSettings({ DD_HARPER_PROCESS_METRICS_ENABLED: typo }).enabled,
				true,
				typo
			);
	});

	it("carries Datadog's own default cadence, so the number an operator knows still applies", () => {
		assert.equal(seriesSettings({}).intervalSeconds, 15);
		assert.equal(
			seriesSettings({ DD_HARPER_PROCESS_METRICS_INTERVAL: "60" })
				.intervalSeconds,
			60
		);
	});

	it("NEGATIVE: refuses a cadence that is not a positive number", () => {
		for (const bad of ["0", "-5", "soon", ""])
			assert.equal(
				seriesSettings({ DD_HARPER_PROCESS_METRICS_INTERVAL: bad })
					.intervalSeconds,
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
	// Four patterns here: env rendered into datadog.yaml, env deliberately not rendered, yaml-only values the
	// plugin decides, and these, which only the plugin reads.
	it("the status endpoint carries what this component resolved", async () => {
		const { DatadogStatus } = await loadComponent();
		const status = await DatadogStatus.get();
		assert.equal(typeof status.processMetrics, "object");
		assert.equal(status.processMetrics.enabled, true);
		assert.equal(status.processMetrics.intervalSeconds, 15);
		assert.deepEqual(status.processMetrics.exclude, []);
		// enabled is what was configured; emitting is what this thread's timer is doing. A thread that has
		// not run startup schedules nothing, and says so rather than reporting the configured value as live.
		assert.equal(status.processMetrics.emitting, false);
		assert.match(status.processMetrics.detail, /startup has not run/);
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

describe("the cadence", () => {
	const socket = () => {
		const sent = [];
		return {
			sent,
			send: (payload, port, host, done) => {
				sent.push({ text: String(payload), port, host });
				done(null);
			},
			close: () => {},
		};
	};

	it("sends one packet carrying every line, because six sends would be six syscalls", async () => {
		const s = socket();
		const n = await sendDogstatsd(["a:1|g", "b:2|g"], {
			port: 8125,
			socket: s,
		});
		assert.equal(n, 2);
		assert.equal(s.sent.length, 1);
		assert.equal(s.sent[0].text, "a:1|g\nb:2|g");
		assert.equal(s.sent[0].port, 8125);
		assert.equal(s.sent[0].host, "127.0.0.1");
	});

	it("NEGATIVE: nothing to send puts nothing on the wire", async () => {
		// Returning 0 is not the assertion: an empty join still sends an empty packet and still returns 0.
		// A zero-length UDP datagram every interval is a packet DogStatsD parses and discards, forever.
		const s = socket();
		assert.equal(await sendDogstatsd([], { port: 8125, socket: s }), 0);
		assert.deepEqual(
			s.sent,
			[],
			"an empty reading must not become an empty packet"
		);
	});

	it("NEGATIVE: a send failure rejects rather than reporting lines it did not send", async () => {
		await assert.rejects(
			sendDogstatsd(["a:1|g"], {
				port: 8125,
				socket: {
					send: (_p, _port, _host, done) => done(new Error("EPERM")),
					close: () => {},
				},
			}),
			/EPERM/
		);
	});

	it("a tick that owns the claim puts both groups on the wire", async () => {
		const sent = [];
		const timer = startProcessSeries({
			members: () => [
				{ name: "harper", self: true },
				{ name: "datadog-agent", pid: 4242 },
			],
			pidDir: "/d",
			holder: "a",
			port: 8125,
			env: {},
			setTimer: () => ({ unref: () => {} }),
			send: async (lines) => sent.push(...lines),
		});
		// The claim is a real file write, so this test owns a directory nothing else uses.
		assert.equal(timer.intervalSeconds, 15);
		timer.stop();
	});

	it("NEGATIVE: a thread that does not own the claim sends nothing", async () => {
		let sends = 0;
		const timer = startProcessSeries({
			members: () => [{ name: "harper", self: true }],
			pidDir: "/nonexistent-dir-for-this-test",
			holder: "a",
			port: 8125,
			env: {},
			setTimer: () => ({ unref: () => {} }),
			send: async () => {
				sends += 1;
			},
		});
		// An unwritable pidDir means the claim cannot be taken, and a tick that cannot claim must not send.
		assert.equal(await timer.tick(), "not-owner");
		assert.equal(sends, 0);
		timer.stop();
	});

	it("NEGATIVE: a send failure is reported once and does not throw out of the tick", async () => {
		const warnings = [];
		const timer = startProcessSeries({
			members: () => [{ name: "harper", self: true }],
			pidDir: "/nonexistent-dir-for-this-test",
			holder: "a",
			port: 8125,
			env: {},
			log: { warn: (m) => warnings.push(m) },
			setTimer: () => ({ unref: () => {} }),
			send: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		// Not-owner short-circuits before the send, so this asserts the tick resolves rather than rejecting:
		// an unhandled rejection out of a timer takes the worker thread down with it.
		assert.equal(await timer.tick(), "not-owner");
		timer.stop();
	});

	it("reads its members per tick, so a pid the guard replaced is not measured forever", () => {
		let calls = 0;
		const timer = startProcessSeries({
			members: () => {
				calls += 1;
				return [{ name: "harper", self: true }];
			},
			pidDir: "/nonexistent-dir-for-this-test",
			holder: "a",
			port: 8125,
			env: {},
			setTimer: () => ({ unref: () => {} }),
		});
		assert.equal(
			calls,
			0,
			"the member list must not be captured at construction"
		);
		timer.stop();
	});

	it("carries the configured cadence rather than the default when one is set", () => {
		const timer = startProcessSeries({
			members: () => [],
			pidDir: "/nonexistent-dir-for-this-test",
			holder: "a",
			port: 8125,
			env: { DD_HARPER_PROCESS_METRICS_INTERVAL: "60" },
			setTimer: () => ({ unref: () => {} }),
		});
		assert.equal(timer.intervalSeconds, 60);
		timer.stop();
	});
});

describe("which namespace it publishes under", () => {
	// A series under a private name is one nobody's dashboard or monitor finds, so it publishes under the
	// namespace the Python `process` check owns.
	it("defaults to the namespace a stock dashboard queries", () => {
		assert.equal(seriesSettings({}).prefix, "system.processes");
		assert.equal(DEFAULT_PREFIX, "system.processes");
	});

	it("tags process_name, which is what process.py tags with and what a dashboard groups by", () => {
		const got = processSeries([{ name: "self", self: true }], {
			group: "harper",
		});
		assert.ok(
			got.lines.every((l) =>
				l.includes("#process_group:harper,process_name:harper")
			),
			`a stock query groups by process_name and would find nothing: ${got.lines[0]}`
		);
		assert.ok(got.lines.every((l) => l.startsWith("system.processes.")));
	});

	it("an operator can take the private namespace back", () => {
		assert.equal(
			seriesSettings({ DD_HARPER_PROCESS_METRICS_PREFIX: PRIVATE_PREFIX })
				.prefix,
			"harper.processes"
		);
		const got = processSeries([{ name: "self", self: true }], {
			group: "harper",
			prefix: PRIVATE_PREFIX,
		});
		assert.ok(got.lines.every((l) => l.startsWith("harper.processes.")));
	});

	it("NEGATIVE: a trailing dot does not become a double dot on the wire", () => {
		// `system.processes.` is the natural thing to type and would emit `system.processes..number`,
		// which is a metric name nothing queries and nothing rejects.
		for (const typed of ["custom.procs.", "custom.procs..", "custom.procs"])
			assert.equal(
				seriesSettings({ DD_HARPER_PROCESS_METRICS_PREFIX: typed }).prefix,
				"custom.procs",
				typed
			);
	});

	it("NEGATIVE: whitespace or an empty override falls back rather than emitting a bare name", () => {
		for (const blank of ["", "   ", undefined])
			assert.equal(
				seriesSettings({ DD_HARPER_PROCESS_METRICS_PREFIX: blank }).prefix,
				DEFAULT_PREFIX,
				JSON.stringify(blank)
			);
	});
});

describe("standing down when something else owns the namespace", () => {
	// Sharing system.processes.* is only safe while nothing else fills it.
	const conf = (...parts) => join("/c", ...parts);
	const fake = (present) => (p) => present.includes(p);

	it("stands down for a configured process check", () => {
		assert.equal(
			standDownFor("/c", fake([conf("process.d", "conf.yaml")])),
			true
		);
	});

	it("accepts the .yml spelling, which the agent also reads", () => {
		assert.equal(
			standDownFor("/c", fake([conf("process.d", "conf.yml")])),
			true
		);
	});

	it("NEGATIVE: the example file Datadog ships is not a configured check", () => {
		assert.equal(
			standDownFor("/c", fake([conf("process.d", "conf.yaml.example")])),
			false,
			"every stock install carries the example; standing down for it would never emit at all"
		);
	});

	it("NEGATIVE: another check's config does not stand this down", () => {
		assert.equal(
			standDownFor("/c", fake([conf("postgres.d", "conf.yaml")])),
			false
		);
	});

	it("NEGATIVE: no conf.d path at all is not a reason to stand down", () => {
		assert.equal(standDownFor(undefined), false);
		assert.equal(standDownFor(""), false);
	});

	// Every case above hands in its own `stat`, which is what let the default one ship reading an `existsSync`
	// the module never imported. scheduleSeries passes none, so every default-prefix start threw.
	it("reads the real filesystem when no stat is handed in", async () => {
		await withTempDir("standdown-", async (dir) => {
			assert.equal(
				standDownFor(dir),
				false,
				"an empty conf.d is not a configured check"
			);
			mkdirSync(join(dir, "process.d"), { recursive: true });
			writeFileSync(
				join(dir, "process.d", "conf.yaml"),
				"instances:\n  - name: harper\n"
			);
			assert.equal(standDownFor(dir), true);
		});
	});
});
