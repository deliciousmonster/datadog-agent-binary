#!/usr/bin/env node
// Turns a soak run's status.tsv and chaos.log into one self-contained HTML report: the load it drove, what it
// cost the node, and where the chaos landed.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const DIR = process.argv[2] ?? "soak-out";
const outFlag = process.argv.indexOf("--out");
const OUT = outFlag > -1 ? process.argv[outFlag + 1] : join(DIR, "report.html");

/** A column's raw text to a number, or null where the run recorded no reading (a paused container, a restart). */
function num(text) {
	if (text === undefined || text === "" || text === "-") return null;
	const value = Number.parseFloat(String(text).replace(/[^0-9.]/g, ""));
	return Number.isFinite(value) ? value : null;
}

/** "1.929GiB" and "847.2MiB" both to MB, so one axis holds a run that crossed the boundary. */
function toMB(text) {
	const value = num(text);
	if (value === null) return null;
	return /GiB/i.test(text) ? value * 1024 : value;
}

const rows = readFileSync(join(DIR, "status.tsv"), "utf8")
	.split("\n")
	.filter((line) => line.trim())
	.map((line) => line.split("\t"));
const header = rows.shift();
const at = (name) => header.indexOf(name);
const samples = rows
	.map((cells) => ({
		t: Date.parse(cells[at("time")].replace(" ", "T") + "Z"),
		label: cells[at("time")],
		cpu: num(cells[at("cpu%")]),
		mem: toMB(cells[at("mem")]),
		harper: num(cells[at("harperMB")]),
		trace: num(cells[at("traceMB")]),
		core: num(cells[at("coreMB")]),
		rps: num(cells[at("req/s")]),
		fail: num(cells[at("fail")]) ?? 0,
		p95: num(cells[at("p95ms")]),
		verdict: cells[at("verdict")],
		verified: cells[at("verified")],
		restarts: cells[at("restarts")],
		spans: num(cells[at("spans")]),
		logs: num(cells[at("logsSent")]),
		logsErr: num(cells[at("logsErr")]) ?? 0,
		statsErr: num(cells[at("statsErr")]) ?? 0,
	}))
	.filter((sample) => Number.isFinite(sample.t));

if (samples.length === 0) {
	console.error(
		`soak report: ${join(DIR, "status.tsv")} holds no readable rows`
	);
	process.exit(1);
}

// One entry per action fired, with the verdict its two-minute read returned where the run got that far.
const chaos = [];
try {
	for (const line of readFileSync(join(DIR, "chaos.log"), "utf8").split("\n")) {
		const fired = line.match(
			/^(\S+ \S+) #(\d+) ([a-z0-9-]+)(?: \(pid \d+\))?: /
		);
		if (fired) {
			chaos.push({
				t: Date.parse(fired[1].replace(" ", "T") + "Z"),
				n: Number(fired[2]),
				name: fired[3],
				outcome: null,
			});
			continue;
		}
		const read = line.match(/^\S+ \S+ #(\d+) ([a-z0-9-]+) after 2 min: (.*)$/);
		if (read) {
			const event = chaos.find((e) => e.n === Number(read[1]));
			if (event) event.outcome = read[3];
			continue;
		}
		const manual = line.match(/^(\S+ \S+) MANUAL (.*)$/);
		if (manual)
			chaos.push({
				t: Date.parse(manual[1].replace(" ", "T") + "Z"),
				n: null,
				name: "manual",
				outcome: manual[2],
			});
	}
} catch {
	// A run with no chaos yet still reports its load.
}

// Requests are a rate sampled once a minute, so the total is the rate integrated over those minutes.
const totals = samples.reduce(
	(acc, sample) => {
		acc.requests += (sample.rps ?? 0) * 60;
		acc.failed += sample.fail;
		acc.logsErr += sample.logsErr;
		acc.statsErr += sample.statsErr;
		return acc;
	},
	{ requests: 0, failed: 0, logsErr: 0, statsErr: 0 }
);
const hours = (samples.at(-1).t - samples[0].t) / 3_600_000;
const peak = (key) => Math.max(...samples.map((s) => s[key] ?? 0));
const finite = (key) => samples.map((s) => s[key]).filter((v) => v !== null);
const mean = (key) => {
	const values = finite(key);
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};
// Drift over the run is the leak question: the last hour's mean against the first hour's.
const window = (key, from, to) => {
	const values = samples
		.slice(from, to)
		.map((s) => s[key])
		.filter((v) => v !== null);
	return values.length
		? values.reduce((a, b) => a + b, 0) / values.length
		: null;
};
const drift = (key) => {
	const span = Math.min(60, Math.floor(samples.length / 3));
	const first = window(key, 0, span);
	const last = window(key, samples.length - span, samples.length);
	return first && last
		? { first, last, pct: ((last - first) / first) * 100 }
		: null;
};

const fmt = {
	int: (n) => Math.round(n).toLocaleString("en-US"),
	one: (n) => n.toFixed(1),
	pct: (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`,
	mb: (n) =>
		n >= 1024 ? `${(n / 1024).toFixed(2)} GB` : `${Math.round(n)} MB`,
};

const harperDrift = drift("harper");
const coreDrift = drift("core");
const traceDrift = drift("trace");

const kpis = [
	{
		label: "Requests driven",
		value: fmt.int(totals.requests),
		unit: `over ${hours.toFixed(1)} h`,
	},
	{
		label: "Failed requests",
		value: fmt.int(totals.failed),
		unit:
			totals.failed === 0
				? "none"
				: `${((totals.failed / totals.requests) * 100).toFixed(3)}% of total`,
		tone: totals.failed / totals.requests > 0.01 ? "warn" : "good",
	},
	{
		label: "Chaos actions",
		value: String(chaos.filter((c) => c.n !== null).length),
		unit: "agents killed, restarts, pauses",
	},
	{
		label: "Harper RSS drift",
		value: harperDrift ? fmt.pct(harperDrift.pct) : "-",
		unit: harperDrift
			? `${fmt.mb(harperDrift.first)} to ${fmt.mb(harperDrift.last)}`
			: "not yet",
		tone: harperDrift && Math.abs(harperDrift.pct) < 5 ? "good" : "warn",
	},
	{
		label: "Agent RSS drift",
		value: coreDrift ? fmt.pct(coreDrift.pct) : "-",
		unit: coreDrift
			? `core agent, ${fmt.mb(coreDrift.first)} to ${fmt.mb(coreDrift.last)}`
			: "not yet",
		tone: coreDrift && Math.abs(coreDrift.pct) < 10 ? "good" : "warn",
	},
	{
		label: "Intake errors",
		value: fmt.int(totals.logsErr + totals.statsErr),
		unit: "log and stats payloads refused",
		tone: totals.logsErr + totals.statsErr === 0 ? "good" : "warn",
	},
];

// Every point ships: 2880 of them at 48 h is a polyline a browser draws without noticing.
const series = samples.map((s) => [
	s.t,
	s.rps,
	s.p95,
	s.cpu,
	s.harper,
	s.core,
	s.trace,
	s.mem,
]);
const data = {
	generated: new Date().toISOString().slice(0, 19).replace("T", " "),
	start: samples[0].label,
	end: samples.at(-1).label,
	hours,
	series,
	chaos: chaos.map((c) => [c.t, c.n, c.name, c.outcome ?? ""]),
	summary: {
		peakCpu: peak("cpu"),
		meanCpu: mean("cpu"),
		peakRps: peak("rps"),
		meanRps: mean("rps"),
		meanP95: mean("p95"),
		peakP95: peak("p95"),
		peakHarper: peak("harper"),
		peakMem: peak("mem"),
		harperDrift,
		coreDrift,
		traceDrift,
	},
};

const html = `<title>Harper Soak Telemetry</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
:root {
  color-scheme: light;
  --ground: #f2f4f3;
  --surface: #ffffff;
  --surface-sunk: #e9edeb;
  --line: #d5dbd8;
  --line-soft: #e6eae8;
  --ink: #101412;
  --ink-2: #4c5652;
  --ink-3: #77827d;
  --accent: #2a78d6;
  --accent-soft: rgba(42, 120, 214, 0.12);
  --s2: #eb6834;
  --s3: #1baf7a;
  --good: #008300;
  --warn: #b45309;
  --shadow: 0 1px 2px rgba(16, 20, 18, 0.06), 0 8px 24px -12px rgba(16, 20, 18, 0.18);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ground: #0e100f;
    --surface: #171a19;
    --surface-sunk: #101312;
    --line: #2c322f;
    --line-soft: #232826;
    --ink: #eef1ef;
    --ink-2: #a8b2ad;
    --ink-3: #7d8883;
    --accent: #3987e5;
    --accent-soft: rgba(57, 135, 229, 0.16);
    --s2: #d95926;
    --s3: #199e70;
    --good: #3fa93f;
    --warn: #d08b2c;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px -12px rgba(0, 0, 0, 0.6);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --ground: #0e100f;
  --surface: #171a19;
  --surface-sunk: #101312;
  --line: #2c322f;
  --line-soft: #232826;
  --ink: #eef1ef;
  --ink-2: #a8b2ad;
  --ink-3: #7d8883;
  --accent: #3987e5;
  --accent-soft: rgba(57, 135, 229, 0.16);
  --s2: #d95926;
  --s3: #199e70;
  --good: #3fa93f;
  --warn: #d08b2c;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px -12px rgba(0, 0, 0, 0.6);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1120px; margin: 0 auto; padding: 40px 24px 72px; }

header.masthead { border-bottom: 1px solid var(--line); padding-bottom: 22px; margin-bottom: 28px; }
.eyebrow {
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3); margin: 0 0 10px;
}
h1 { font-size: clamp(26px, 3.4vw, 36px); line-height: 1.15; margin: 0 0 10px; letter-spacing: -0.02em; text-wrap: balance; font-weight: 600; }
.standfirst { margin: 0; color: var(--ink-2); max-width: 64ch; }
.runbar {
  display: flex; flex-wrap: wrap; gap: 6px 22px; margin-top: 16px;
  font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; color: var(--ink-3);
}
.runbar b { font-weight: 500; color: var(--ink-2); }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 10px; overflow: hidden; margin-bottom: 32px; }
.kpi { background: var(--surface); padding: 16px 18px 18px; }
.kpi .k-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
.kpi .k-value { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 27px; font-weight: 500; letter-spacing: -0.02em; margin-top: 6px; font-variant-numeric: tabular-nums; }
.kpi .k-unit { font-size: 12px; color: var(--ink-3); margin-top: 3px; }
.kpi.good .k-value { color: var(--good); }
.kpi.warn .k-value { color: var(--warn); }

.panel { background: var(--surface); border: 1px solid var(--line-soft); border-radius: 10px; box-shadow: var(--shadow); padding: 18px 20px 12px; margin-bottom: 18px; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 4px; }
.panel-head h2 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.panel-head .sub { font-size: 12.5px; color: var(--ink-3); font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; }

.tip {
  position: fixed; z-index: 20; pointer-events: none; opacity: 0;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: var(--shadow); padding: 10px 12px; min-width: 190px;
  font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px;
  font-variant-numeric: tabular-nums; transition: opacity 0.09s;
}
.tip .t-time { color: var(--ink-3); margin-bottom: 6px; }
.tip .t-row { display: flex; justify-content: space-between; gap: 18px; }
.tip .t-row b { font-weight: 500; }

details.table-view { background: var(--surface); border: 1px solid var(--line-soft); border-radius: 10px; padding: 0 20px; margin-top: 26px; }
details.table-view summary { cursor: pointer; padding: 16px 0; font-weight: 500; font-size: 14px; }
details.table-view summary::marker { color: var(--ink-3); }
.scroller { overflow-x: auto; padding-bottom: 18px; }
table { border-collapse: collapse; width: 100%; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 7px 12px; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--ink-3); font-weight: 500; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }

.events { margin-top: 26px; }
.events h2 { font-size: 15px; margin: 0 0 12px; }
.event-list { display: grid; gap: 1px; background: var(--line-soft); border: 1px solid var(--line-soft); border-radius: 10px; overflow: hidden; }
.event { background: var(--surface); display: grid; grid-template-columns: 34px 132px 1fr; gap: 14px; align-items: baseline; padding: 11px 16px; font-size: 13px; }
.event .n { font-family: "IBM Plex Mono", ui-monospace, monospace; color: var(--ink-3); font-size: 12px; }
.event .name { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12.5px; color: var(--ink); }
.event .outcome { color: var(--ink-2); overflow-wrap: anywhere; }

footer { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--ink-3); font-size: 12.5px; }
footer p { margin: 0 0 6px; max-width: 72ch; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">Soak run &middot; harper-demo</p>
    <h1>48-hour load and chaos run</h1>
    <p class="standfirst">A stock <code>harperfast/harper</code> container running the e-commerce template and
      <code>@deliciousmonster/datadog-agent-binary</code>, driven at 20 requests a second while agents are killed,
      the container is restarted and paused, and the API key is broken and restored. Every figure below is read
      from the node itself once a minute.</p>
    <div class="runbar">
      <span><b>Started</b> ${data.start}</span>
      <span><b>Latest sample</b> ${data.end}</span>
      <span><b>Samples</b> ${samples.length}</span>
      <span><b>Generated</b> ${data.generated} UTC</span>
    </div>
  </header>

  <section class="kpis">
    ${kpis.map((k) => `<div class="kpi ${k.tone ?? ""}"><div class="k-label">${k.label}</div><div class="k-value">${k.value}</div><div class="k-unit">${k.unit}</div></div>`).join("\n    ")}
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Requests per second</h2>
      <span class="sub">mean ${fmt.one(data.summary.meanRps)} &middot; peak ${fmt.one(data.summary.peakRps)}</span>
    </div>
    <div class="chart" data-chart="rps"></div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Latency, p95</h2>
      <span class="sub">mean ${fmt.int(data.summary.meanP95)} ms &middot; peak ${fmt.int(data.summary.peakP95)} ms</span>
    </div>
    <div class="chart" data-chart="p95"></div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Container CPU</h2>
      <span class="sub">mean ${fmt.one(data.summary.meanCpu)}% &middot; peak ${fmt.one(data.summary.peakCpu)}%</span>
    </div>
    <div class="chart" data-chart="cpu"></div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Harper resident memory</h2>
      <span class="sub">peak ${fmt.mb(data.summary.peakHarper)}${harperDrift ? ` &middot; drift ${fmt.pct(harperDrift.pct)}` : ""}</span>
    </div>
    <div class="chart" data-chart="harper"></div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Agent resident memory</h2>
      <div class="legend">
        <span><i class="swatch" style="background: var(--s2)"></i>core agent</span>
        <span><i class="swatch" style="background: var(--s3)"></i>trace-agent</span>
      </div>
    </div>
    <div class="chart" data-chart="agents"></div>
  </section>

  <section class="events">
    <h2>Chaos actions</h2>
    <div class="event-list">
      ${chaos.length === 0 ? '<div class="event"><span class="n">-</span><span class="name">none yet</span><span class="outcome">the first action fires within thirty minutes of the start</span></div>' : chaos.map((c) => `<div class="event"><span class="n">${c.n ?? "&middot;"}</span><span class="name">${c.name}</span><span class="outcome">${(c.outcome || "read pending").replace(/[<>&]/g, "")}</span></div>`).join("\n      ")}
    </div>
  </section>

  <details class="table-view">
    <summary>Hourly table</summary>
    <div class="scroller"><table id="hourly"></table></div>
  </details>

  <footer>
    <p>Requests are counted by integrating the sampled rate over each minute, so the total is a close estimate rather than a
      per-request tally. Resident memory is read from <code>/proc/&lt;pid&gt;/status</code> inside the container; container CPU and
      memory come from <code>docker stats</code>. Gaps in a line are minutes when the container was paused or restarting and
      nothing answered.</p>
    <p>Drift compares the mean of the last hour against the mean of the first, which is the leak question this run exists to answer.</p>
  </footer>
</div>

<div class="tip" id="tip"></div>

<script>
const DATA = ${JSON.stringify(data)};
const S = DATA.series;
const IDX = { t: 0, rps: 1, p95: 2, cpu: 3, harper: 4, core: 5, trace: 6, mem: 7 };

const CHARTS = {
  rps:    { height: 156, area: true,  series: [{ key: "rps", color: "--accent", label: "req/s" }], unit: "" },
  p95:    { height: 140, area: false, series: [{ key: "p95", color: "--accent", label: "p95" }], unit: " ms" },
  cpu:    { height: 156, area: true,  series: [{ key: "cpu", color: "--accent", label: "CPU" }], unit: "%" },
  harper: { height: 156, area: true,  series: [{ key: "harper", color: "--accent", label: "Harper" }], unit: " MB" },
  agents: { height: 170, area: false, series: [{ key: "core", color: "--s2", label: "core agent" }, { key: "trace", color: "--s3", label: "trace-agent" }], unit: " MB" },
};

const PAD = { l: 54, r: 16, t: 12, b: 22 };
const t0 = S[0][0], t1 = S[S.length - 1][0], span = Math.max(1, t1 - t0);

function niceTicks(max) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

const fmtVal = (v, unit) => (v === null ? "-" : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))) + unit);
const clock = (ms) => new Date(ms).toISOString().slice(11, 16);
const dayClock = (ms) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

function render() {
  for (const [name, spec] of Object.entries(CHARTS)) {
    const host = document.querySelector('[data-chart="' + name + '"]');
    if (!host) continue;
    const w = Math.max(320, host.clientWidth);
    const h = spec.height;
    const plotW = w - PAD.l - PAD.r, plotH = h - PAD.t - PAD.b;
    let max = 0;
    for (const s of S) for (const ser of spec.series) { const v = s[IDX[ser.key]]; if (v !== null && v > max) max = v; }
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const x = (t) => PAD.l + ((t - t0) / span) * plotW;
    const y = (v) => PAD.t + plotH - (v / top) * plotH;

    const parts = [];
    for (const tick of ticks) {
      const yy = y(tick).toFixed(1);
      parts.push('<line x1="' + PAD.l + '" x2="' + (w - PAD.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--line-soft)" stroke-width="1"></line>');
      parts.push('<text x="' + (PAD.l - 9) + '" y="' + (Number(yy) + 4) + '" text-anchor="end" fill="var(--ink-3)" font-size="11" font-family="IBM Plex Mono, monospace">' + fmtVal(tick, "") + '</text>');
    }

    // Chaos rules run the full height of every chart, so an excursion lines up with what caused it.
    for (const [ct] of DATA.chaos) {
      if (ct < t0 || ct > t1) continue;
      const cx = x(ct).toFixed(1);
      parts.push('<line x1="' + cx + '" x2="' + cx + '" y1="' + PAD.t + '" y2="' + (PAD.t + plotH) + '" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 4" opacity="0.55"></line>');
    }

    const hourStep = DATA.hours > 24 ? 6 : DATA.hours > 8 ? 3 : DATA.hours > 3 ? 1 : 0.5;
    const startHour = Math.ceil(t0 / (hourStep * 3600000)) * hourStep * 3600000;
    for (let tt = startHour; tt <= t1; tt += hourStep * 3600000) {
      parts.push('<text x="' + x(tt).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle" fill="var(--ink-3)" font-size="11" font-family="IBM Plex Mono, monospace">' + clock(tt) + '</text>');
    }

    for (const ser of spec.series) {
      const col = 'var(' + ser.color + ')';
      let d = "", areaD = "", open = false, firstX = null, lastX = null;
      for (const s of S) {
        const v = s[IDX[ser.key]];
        if (v === null) { open = false; continue; }
        const px = x(s[0]).toFixed(1), py = y(v).toFixed(1);
        d += (open ? "L" : "M") + px + " " + py + " ";
        if (!open && spec.area) { areaD += "M" + px + " " + (PAD.t + plotH) + " L" + px + " " + py + " "; }
        else if (spec.area) areaD += "L" + px + " " + py + " ";
        if (firstX === null) firstX = px;
        lastX = px;
        open = true;
      }
      if (spec.area && areaD) areaD += "L" + lastX + " " + (PAD.t + plotH) + " Z";
      if (spec.area && areaD) parts.push('<path d="' + areaD + '" fill="' + col + '" opacity="0.10"></path>');
      parts.push('<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>');
      // The endpoint is where the run is now; a reader looking for drift ends here.
      const last = [...S].reverse().find((s) => s[IDX[ser.key]] !== null);
      if (last) parts.push('<circle cx="' + x(last[0]).toFixed(1) + '" cy="' + y(last[IDX[ser.key]]).toFixed(1) + '" r="3.5" fill="' + col + '" stroke="var(--surface)" stroke-width="2"></circle>');
    }

    parts.push('<line class="cross" x1="0" x2="0" y1="' + PAD.t + '" y2="' + (PAD.t + plotH) + '" stroke="var(--ink-2)" stroke-width="1" opacity="0"></line>');
    host.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + name + ' over the run">' + parts.join("") + "</svg>";
    host.dataset.plot = JSON.stringify({ l: PAD.l, w: plotW });
  }
}

const tip = document.getElementById("tip");
function nearest(clientX, host) {
  const box = host.getBoundingClientRect();
  const plot = JSON.parse(host.dataset.plot || "{}");
  const scale = box.width / (plot.l + plot.w + PAD.r);
  const rel = (clientX - box.left) / scale;
  const frac = Math.min(1, Math.max(0, (rel - plot.l) / plot.w));
  const target = t0 + frac * span;
  let best = 0, bestGap = Infinity;
  for (let i = 0; i < S.length; i++) { const gap = Math.abs(S[i][0] - target); if (gap < bestGap) { bestGap = gap; best = i; } }
  return best;
}
function moveCross(index) {
  for (const host of document.querySelectorAll("[data-chart]")) {
    const plot = JSON.parse(host.dataset.plot || "{}");
    const line = host.querySelector(".cross");
    if (!line || !plot.w) continue;
    const px = plot.l + ((S[index][0] - t0) / span) * plot.w;
    line.setAttribute("x1", px); line.setAttribute("x2", px); line.setAttribute("opacity", "0.45");
  }
}
function hideCross() {
  for (const line of document.querySelectorAll(".cross")) line.setAttribute("opacity", "0");
  tip.style.opacity = "0";
}
const ROWS = [
  ["req/s", "rps", ""], ["p95", "p95", " ms"], ["CPU", "cpu", "%"],
  ["Harper", "harper", " MB"], ["core agent", "core", " MB"], ["trace-agent", "trace", " MB"],
];
for (const host of document.querySelectorAll("[data-chart]")) {
  host.addEventListener("pointermove", (event) => {
    const index = nearest(event.clientX, host);
    moveCross(index);
    const s = S[index];
    tip.innerHTML = '<div class="t-time">' + dayClock(s[0]) + " UTC</div>" +
      ROWS.map(([label, key, unit]) => '<div class="t-row"><span>' + label + "</span><b>" + fmtVal(s[IDX[key]], unit) + "</b></div>").join("");
    const w = tip.offsetWidth || 200;
    tip.style.left = Math.min(window.innerWidth - w - 12, event.clientX + 16) + "px";
    tip.style.top = Math.min(window.innerHeight - tip.offsetHeight - 12, event.clientY + 14) + "px";
    tip.style.opacity = "1";
  });
  host.addEventListener("pointerleave", hideCross);
}

// The table view: one row an hour, so a reader who cannot use the charts still gets the shape.
(function hourly() {
  const buckets = new Map();
  for (const s of S) {
    const key = Math.floor(s[0] / 3600000) * 3600000;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  const avg = (rows, i) => { const v = rows.map((r) => r[i]).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const head = ["Hour (UTC)", "req/s", "p95 ms", "CPU %", "Harper MB", "core MB", "trace MB", "samples"];
  let html = "<thead><tr>" + head.map((h) => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>";
  for (const [key, rows] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    html += "<tr><td>" + dayClock(key) + "</td>" +
      [IDX.rps, IDX.p95, IDX.cpu, IDX.harper, IDX.core, IDX.trace].map((i) => "<td>" + fmtVal(avg(rows, i), "") + "</td>").join("") +
      "<td>" + rows.length + "</td></tr>";
  }
  document.getElementById("hourly").innerHTML = html + "</tbody>";
})();

render();
// The first paint can land before the frame has its final width, which drew every chart into a third of the
// panel until something resized it.
let resizeTimer;
const redraw = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 90); };
new ResizeObserver(redraw).observe(document.querySelector("[data-chart]").parentElement);
addEventListener("resize", redraw);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(render);
</script>
`;

writeFileSync(OUT, html);
console.log(
	`soak report: ${OUT} (${samples.length} samples over ${hours.toFixed(2)}h, ${chaos.filter((c) => c.n !== null).length} chaos actions)`
);
