// Suppression measured on a real tracer, at the point spans leave it, rather than on the arguments handed to
// a fake one. A blocklist is one process-global setting and dd-trace's configurePlugin replaces a plugin's
// config rather than merging into it, so the next caller to touch the same plugin wins it outright.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { REPO_ROOT } from "../support/component.js";
import { findFreePort } from "../support/loopback.js";

// dd-trace initialises once per process, so this runs in a child. Its `log` exporter writes every exported
// span to stdout instead of posting msgpack, which is what makes the count readable without decoding a payload.
const CHILD_SCRIPT = `
const tracer = require('dd-trace').init({ startupLogs: false, experimental: { exporter: 'log' } });
const { pathToFileURL } = require('node:url');

const mark = (phase) => process.stdout.write('##' + phase + '\\n');
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
// giveUp after the first failure: exactly one request per probe, so a count is a count and not a race with the backoff.
const once = (extra) => ({ timeoutMs: 2000, giveUp: () => true, ...extra });

(async () => {
	const { pollEndpoint } = await import(pathToFileURL(process.env.PROBE_FILE).href);
	// Importing the module is what installs the blocklist; calling the export by hand would test a path Harper never takes.
	await import(pathToFileURL(process.env.RESOURCES_FILE).href);

	const probeBoth = async () => {
		await pollEndpoint(once({ url: process.env.FETCH_PROBE_URL }));
		await pollEndpoint(once({ url: process.env.HTTPS_PROBE_URL, insecureTls: true }));
		await settle();
	};

	mark('boot');
	await probeBoth();

	// Another component, or the host application, configuring the same plugins for its own reasons.
	tracer.use('http', { headers: ['x-request-id'] });
	tracer.use('fetch', { headers: ['x-request-id'] });
	mark('reconfigured');
	await probeBoth();

	mark('control');
	await fetch(process.env.CONTROL_URL).catch(() => {});
	await settle();

	mark('end');
	process.exit(0);
})();
`;

/** Exported spans per phase marker, as {name, resource}; anything that is not a log-exporter line is the child's own noise. */
function spansByPhase(stdout) {
	const phases = new Map([["startup", []]]);
	let current = "startup";
	for (const line of stdout.split("\n")) {
		if (line.startsWith("##")) {
			current = line.slice(2);
			if (!phases.has(current)) phases.set(current, []);
			continue;
		}
		if (!line.startsWith('{"traces"')) continue;
		for (const chunk of JSON.parse(line).traces) {
			for (const span of chunk) {
				phases.get(current).push({ name: span.name, resource: span.resource });
			}
		}
	}
	return phases;
}

function runChild(env) {
	return execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		timeout: 120_000,
		env: {
			...process.env,
			...env,
			// Offline: nothing here should reach an agent, an intake or a remote config endpoint.
			DD_TRACE_STARTUP_LOGS: "false",
			DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
			DD_REMOTE_CONFIGURATION_ENABLED: "false",
			DD_CRASHTRACKING_ENABLED: "false",
		},
	});
}

test("NEGATIVE: a quiet boot exports no span for the plugin's own probes, and a later tracer.use does not put them back", async () => {
	// The receiver port resources.js really polls, so the blocklist it installs at import covers this one.
	const fetchProbeUrl = "http://127.0.0.1:8126/info";
	// Deliberately not a blocklisted URL: a refused https read emits a ROOT tcp.connect error span from the
	// net plugin, with no http.request sibling for any blocklist entry to match. Only the store reaches it.
	const httpsProbePort = await findFreePort();
	const httpsProbeUrl = `https://127.0.0.1:${httpsProbePort}/debug/vars`;
	const controlPort = await findFreePort();

	const phases = spansByPhase(
		runChild({
			FETCH_PROBE_URL: fetchProbeUrl,
			HTTPS_PROBE_URL: httpsProbeUrl,
			CONTROL_URL: `http://127.0.0.1:${controlPort}/control`,
			PROBE_FILE: path.join(REPO_ROOT, "probe.js"),
			RESOURCES_FILE: path.join(REPO_ROOT, "resources.js"),
		})
	);

	// The sensitivity control, last so it also proves nothing above silenced the tracer wholesale: an
	// unsuppressed request to a closed port is an errored client span plus its tcp.connect child.
	assert.ok(
		phases.get("control")?.some((span) => span.name === "http.request"),
		`an unsuppressed fetch exported ${JSON.stringify(phases.get("control"))}, so this run cannot tell a suppressed probe from a dead tracer`
	);

	// By resource rather than by total: a real Harper emits dns.lookup, graphql.parse and getconf of its own
	// on a quiet boot, so "no spans at all" is the wrong assertion to carry into one.
	const probeSpans = (phase) =>
		phases
			.get(phase)
			.filter(
				(span) =>
					String(span.resource ?? "").includes("8126") ||
					String(span.resource ?? "").includes(String(httpsProbePort)) ||
					span.name === "tcp.connect"
			);

	assert.deepEqual(
		probeSpans("boot"),
		[],
		"the agent probes reached the customer's APM on a quiet boot"
	);
	assert.deepEqual(
		probeSpans("reconfigured"),
		[],
		"the probes are traced again once another caller reconfigures the http and fetch plugins, which is what a blocklist alone cannot survive"
	);
	// The child does nothing else, so in this process the two readings agree; a divergence would mean the
	// filter above is quietly discarding a plugin span rather than there being none.
	assert.deepEqual(
		[phases.get("boot").length, phases.get("reconfigured").length],
		[0, 0],
		"spans were exported during the probe phases that the resource filter did not attribute to the probes"
	);
});
