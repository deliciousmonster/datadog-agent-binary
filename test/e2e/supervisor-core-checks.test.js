/**
 * The core-check configurations the supervisor writes into the runtime conf.d.
 *
 * Every core check is compiled into the shipped binary, but the collector schedules only what
 * conf.d names. An agent started against a conf.d holding nothing but the Harper log source
 * runs no check at all: `configcheck` prints nothing, `status` reports "No checks have run
 * yet", and `datadog.agent.running` keeps arriving because the aggregator appends it to every
 * flush rather than collecting it. A metrics pipeline that demonstrably works and carries not
 * one series about the host is what that combination looks like from Datadog.
 *
 * So these cases assert the tree, not the strings that went into it. The tree is what the
 * agent reads, and the tree is what was empty.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, createDistSandbox, makeTempDir, withEnv } from '../support/harness.js';

/**
 * The supervisor resolves the shipped configurations through the package rather than through
 * the component directory, so the sandbox has to carry conf.d as well as dist. Both the
 * component copy of the file and the package it imports are then the sandbox's own.
 */
const sandbox = createDistSandbox({ prefix: 'ddab-core-checks-', include: ['conf.d'] });
fs.copyFileSync(path.join(REPO_ROOT, 'example', 'dd-supervisor.js'), path.join(sandbox, 'dd-supervisor.js'));
fs.cpSync(path.join(REPO_ROOT, 'example', 'conf.d'), path.join(sandbox, 'conf.d'), { recursive: true });
const { prepareRuntime } = await import(pathToFileURL(path.join(sandbox, 'dd-supervisor.js')).href);

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const PACKAGE_CONFD = path.join(REPO_ROOT, 'conf.d');

/** Check directories the package ships a configuration for, and the platforms each applies to. */
function shippedChecks() {
	return fs
		.readdirSync(PACKAGE_CONFD, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(PACKAGE_CONFD, entry.name, 'conf.yaml.default')))
		.map((entry) => {
			const gate = path.join(PACKAGE_CONFD, entry.name, 'platforms');
			return {
				dir: entry.name,
				name: entry.name.slice(0, -'.d'.length),
				platforms: fs.existsSync(gate)
					? fs.readFileSync(gate, 'utf-8').replace(/#.*$/gm, '').split(/\s+/).filter(Boolean)
					: null,
			};
		});
}

/**
 * `prepareRuntime` against a throwaway Harper root, with hdb.log already present so the log
 * source is written without a warning about a file the agent would tail into nothing.
 */
async function withRuntime(run) {
	const root = makeTempDir('ddab-core-checks-root-');
	try {
		fs.mkdirSync(path.join(root, 'log'), { recursive: true });
		fs.writeFileSync(path.join(root, 'log', 'hdb.log'), '');
		return await withEnv('ROOTPATH', root, () => run(path.join(root, 'datadog'), root));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('the runtime conf.d carries a core-check configuration, not just the log source', () =>
	withRuntime((runtimeDir) => {
		prepareRuntime(sandbox);

		// Anchored on cpu by name rather than on "something was written": a package whose conf.d
		// lost every check would otherwise satisfy a derived expectation of nothing, which is
		// precisely the state this suite exists to catch.
		const cpu = path.join(runtimeDir, 'conf.d', 'cpu.d', 'conf.yaml.default');
		assert.ok(fs.existsSync(cpu), `${cpu} is missing, so the agent collects no system.cpu.* at all`);
		assert.match(fs.readFileSync(cpu, 'utf-8'), /^instances:/m);
	}));

test('every shipped check that applies to this platform reaches the runtime tree', () =>
	withRuntime((runtimeDir) => {
		const { coreChecks } = prepareRuntime(sandbox);
		const expected = shippedChecks().filter((check) => !check.platforms || check.platforms.includes(process.platform));

		assert.deepEqual([...coreChecks].sort(), expected.map((check) => check.name).sort());
		for (const check of expected) {
			const written = path.join(runtimeDir, 'conf.d', check.dir, 'conf.yaml.default');
			assert.equal(
				fs.readFileSync(written, 'utf-8'),
				fs.readFileSync(path.join(PACKAGE_CONFD, check.dir, 'conf.yaml.default'), 'utf-8'),
				`${check.name} was written, but not from the shipped file`
			);
		}
	}));

test('a check with no implementation for this platform is not written', () =>
	withRuntime((runtimeDir) => {
		const gated = shippedChecks().filter((check) => check.platforms && !check.platforms.includes(process.platform));
		if (gated.length === 0) return; // Every shipped check applies here. Nothing to prove.

		prepareRuntime(sandbox);
		for (const check of gated) {
			// Not inert: the collector lists a config it cannot load under Loading Errors in
			// `datadog-agent status`, which reads as a broken install rather than as a check that
			// was never going to run on this platform.
			assert.ok(
				!fs.existsSync(path.join(runtimeDir, 'conf.d', check.dir, 'conf.yaml.default')),
				`${check.name} does not build for ${process.platform} and should not have been written`
			);
		}
	}));

test('the shipped files use the extension the agent reads', () => {
	for (const check of shippedChecks()) {
		// `.example` is skipped outright by the file provider (config_reader.go rejects any
		// extension that is not .yaml or .yml), and a plain `conf.yaml` would take the slot an
		// operator's own override needs.
		assert.deepEqual(
			fs.readdirSync(path.join(PACKAGE_CONFD, check.dir)).sort(),
			['conf.yaml.default', ...(check.platforms ? ['platforms'] : [])].sort(),
			`${check.name} ships a file that is neither the default config nor its platform gate`
		);
	}
});

test("an operator's own conf.yaml survives a restart, and stale defaults do not", () =>
	withRuntime((runtimeDir) => {
		const confd = path.join(runtimeDir, 'conf.d');
		fs.mkdirSync(path.join(confd, 'cpu.d'), { recursive: true });
		fs.mkdirSync(path.join(confd, 'retired.d'), { recursive: true });
		fs.writeFileSync(path.join(confd, 'cpu.d', 'conf.yaml'), 'instances:\n  - report_total_percpu: true\n');
		fs.writeFileSync(path.join(confd, 'retired.d', 'conf.yaml.default'), 'instances:\n  - {}\n');
		fs.writeFileSync(path.join(confd, 'retired.d', 'conf.yaml'), 'instances:\n  - {}\n');

		prepareRuntime(sandbox);

		// The file provider drops a default whenever a plain conf.yaml for the same check sits
		// beside it, so the override is what runs and the supervisor never has to know about it.
		assert.equal(
			fs.readFileSync(path.join(confd, 'cpu.d', 'conf.yaml'), 'utf-8'),
			'instances:\n  - report_total_percpu: true\n'
		);
		// The runtime tree sits on a persistent volume and outlives the package version that
		// wrote it, so a default nobody claims this start is one the supervisor left behind.
		assert.ok(!fs.existsSync(path.join(confd, 'retired.d', 'conf.yaml.default')));
		assert.ok(
			fs.existsSync(path.join(confd, 'retired.d', 'conf.yaml')),
			'the supervisor owns the defaults and nothing else'
		);
	}));

test('a package with no conf.d leaves the trace-agent path intact', () =>
	withRuntime(() => {
		const confd = path.join(sandbox, 'conf.d');
		const stashed = `${confd}.stashed`;
		fs.renameSync(confd, stashed);
		try {
			// Log collection and host metrics are both optional; the trace-agent is not. An
			// earlier version of the log-source path threw out of prepareRuntime and the catch
			// around it stopped BOTH spawns, so a renamed conf.d took APM down with it.
			const { coreChecks, paths } = prepareRuntime(sandbox);
			assert.deepEqual(coreChecks, []);
			assert.ok(fs.existsSync(paths.configFile), 'datadog.yaml must still exist or the trace-agent dies at start');
		} finally {
			fs.renameSync(stashed, confd);
		}
	}));

/**
 * A `warn` entry as Harper writes it, with the stack the example's deliberate Error produces.
 * Copied from a real hdb.log rather than composed, because the whole question below is
 * whether the shipped rule treats this shape as one entry or as five.
 */
const HARPER_WARN_ENTRY = [
	'2026-08-27T05:21:23.291Z [http/2] [warn]: Datadog example: emitting a deliberate multi-line log entry Error: This error is intentional.',
	'    at file:///app/components/harper-datadog-example/resources.js:135:6',
	'    at async http (/opt/harper/server/REST.ts:215:22)',
	'    at async authentication (/opt/harper/security/auth.ts:345:20)',
];

const HARPER_INFO_LINE = '2026-08-27T05:21:23.290Z [http/2] [info]: Datadog example: handling GET /Work/ in trace 903';

/** The multi_line pattern out of the rendered source, as the Agent would apply it. */
function multiLinePattern(logsYaml) {
	const pattern = logsYaml.match(/pattern:\s*'([^']+)'/)?.[1];
	assert.ok(pattern, 'the rendered log source carries no multi_line pattern');
	// Datadog anchors a multi_line pattern to the start of the line, so the rule is "does a
	// new entry begin here", not "does this appear anywhere".
	return new RegExp(`^(?:${pattern})`);
}

test('NEGATIVE: a warn entry begins its own log, it is not folded into the info above it', () =>
	withRuntime((runtimeDir) => {
		prepareRuntime(sandbox);
		const logsYaml = fs.readFileSync(path.join(runtimeDir, 'conf.d', 'harperdb.d', 'conf.yaml'), 'utf-8');
		const startsEntry = multiLinePattern(logsYaml);

		// The reading this rules out: that Datadog shows Warn 0 because the multi_line rule
		// swallowed every warn into the preceding info entry. It does not. The severity gap is
		// elsewhere, and looking in the wrong place would have produced a rule change that
		// broke stack-trace reassembly without fixing anything.
		assert.ok(startsEntry.test(HARPER_WARN_ENTRY[0]), 'a warn line must start a new entry, not continue the one above');
		assert.ok(startsEntry.test(HARPER_INFO_LINE), 'an info line must start a new entry');
		for (const frame of HARPER_WARN_ENTRY.slice(1)) {
			assert.ok(!startsEntry.test(frame), `a stack frame must continue the entry above it: ${frame}`);
		}
	}));

test('the log source carries the attribute a severity pipeline filters on', () =>
	withRuntime((runtimeDir) => {
		prepareRuntime(sandbox);
		const logsYaml = fs.readFileSync(path.join(runtimeDir, 'conf.d', 'harperdb.d', 'conf.yaml'), 'utf-8');

		// Harper's format is not JSON and the Agent's processing rules cannot set a log's
		// status, so every entry lands as `info` until a Datadog pipeline parses the level.
		// `source` is what such a pipeline filters on, and it is the only part of that fix
		// this package can ship.
		assert.match(
			logsYaml,
			/^ {4}source: "harper"$/m,
			'no `source` on the log source, so a pipeline has nothing stable to key on'
		);
		assert.ok(
			!/source: "harperdb"/.test(logsYaml),
			'`harperdb` is a Datadog integration name; using it routes these logs into an ' +
				'integration pipeline written for a different format'
		);
	}));
