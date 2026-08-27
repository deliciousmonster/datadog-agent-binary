/**
 * The shipped example supervisor under Harper v5 spawn enforcement, against a
 * real Harper instance.
 *
 * example/dd-supervisor.js is the documented correct pattern, and this suite
 * executes that file. Its predecessor ran a private probe component that
 * near-duplicated the supervisor's spawn pattern (interception detection, the
 * name+PID-lock spawn, the spawnargs adoption test), so CI proved the copy while
 * the shipped file had never been executed. The fixture now reaches the example
 * by a relative ESM import - the loading pattern the example itself documents as
 * load-bearing - with the file copied into the assembled application at setup,
 * so example/ remains the single source.
 *
 * The negative assertions still come first. Harper v4 does not replace
 * `node:child_process` for component code at all, and a suite that passes
 * because enforcement is absent is indistinguishable from one that passes
 * because the allowlist is right. The no-name probe (the one enforcement rule
 * the example never exercises) and the example's own interception probe are
 * what make every later assertion mean something.
 *
 * The harness is Harper's own (@harperfast/integration-testing): a temporary
 * install dir, a loopback address from a cross-process pool, and a real `harper`
 * process per suite.
 *
 * The last suite repeats the launch assertions against the real Datadog
 * binaries and skips cleanly when they have not been built, so the hermetic
 * suites under test/unit and test/e2e still cover a machine that has never run a
 * build.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	sendOperation,
	setupHarperWithFixture,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import {
	darwinLoopbackSkipReason,
	errorMessage,
	makeTempDir,
	PACKAGE_MANIFEST,
	pollJsonlRows,
	REPO_ROOT,
	resolveHarperBinPath,
} from './support/harness.ts';

const require = createRequire(import.meta.url);

const EXAMPLE_DIR = join(REPO_ROOT, 'example');
const PACKAGE_DIST_DIR = join(REPO_ROOT, 'dist');
const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'datadog-example-app');
/** Component name inside the Harper install; the assembled app dir's basename. */
const APP_NAME = 'datadog-example-app';

/** The names the example's AGENTS table hands to Harper; trace-agent first. */
const TRACE_AGENT_NAME = 'datadog-trace-agent';
const CORE_AGENT_NAME = 'datadog-agent';
const AGENT_NAMES = [TRACE_AGENT_NAME, CORE_AGENT_NAME];
/** The reaper's own PID lock. Deliberately not in AGENT_NAMES: it is not a Datadog process. */
const REAPER_NAME = 'datadog-agent-reaper';

const harperBinPath = resolveHarperBinPath();

/**
 * Worker threads to ask for. macOS and Windows *default* to 1 (without
 * SO_REUSEPORT extra HTTP workers cannot share the server ports), and `harper
 * dev` forces 1 outright via DEV_MODE. An explicit threads.count still wins, and
 * the harness runs plain `harper`. The supervisor runs at component load, which
 * happens in every thread regardless of how HTTP traffic is routed. If the
 * runtime still gives us a single thread, the singleton test skips with the count
 * rather than passing vacuously against a race that never happened.
 */
const REQUESTED_THREAD_COUNT = 4;

const SKIP_REASON: string | false =
	process.platform === 'win32'
		? "Harper spawn enforcement is exercised with a shebang'd stub executable and " +
			'counted with ps(1); neither works on Windows'
		: !harperBinPath
			? 'the `harper` package is not installed; `npm ci` provides it through ' +
				"@harperfast/integration-testing's peer dependency (never add harper " +
				'itself to a dependencies key: the manifest guard test forbids it)'
			: !existsSync(join(PACKAGE_DIST_DIR, 'index.js'))
				? 'dist/ has not been built, and the assembled application ships this ' +
					"repo's real dist/ into the Harper component; run `npm run build` first"
				: await darwinLoopbackSkipReason();

/** One agent entry of the supervisor's status object (startAgent's return). */
type AgentRow = {
	kind: string;
	name: string;
	started: boolean;
	binaryPath: string;
	pid?: number;
	adopted?: boolean;
	receiverBound?: boolean;
	error?: string;
};

/** What startDatadogAgents() resolves to, flattened through JSON. */
type SupervisorStatus = {
	interception: { intercepted: boolean; detail: string };
	receiverPort: number;
	apiKey: string;
	agents: AgentRow[];
	runtimeDir?: string;
	configFile?: string;
	harperLogPath?: string | null;
	service?: string;
	/** Core checks whose configuration reached the runtime conf.d, by check name. */
	coreChecks?: string[];
	/** The process that stops the agents when this node does. Never in `agents`. */
	reaper?: { name: string; started: boolean; pid?: number; adopted?: boolean; command?: string; error?: string };
	version?: number;
	error?: string;
};

type ProbeRow = {
	threadId: number;
	probe: string;
	threw?: boolean;
	error?: string;
	status?: SupervisorStatus;
};

/**
 * The stub executables and the fixture's output. Kept outside the Harper install
 * dir so teardown (which deletes that dir) cannot race the assertions that read
 * the results back.
 */
type Workspace = {
	dir: string;
	longLivedCommand: string;
	deniedCommand: string;
	resultsFile: string;
};

function createWorkspace(): Workspace {
	const dir = makeTempDir('ddab-harper-spawn-');

	// Stands in for an agent binary: stays alive until killed, the interval being
	// the only thing holding its event loop open. It deliberately does NOT set
	// process.title, which overwrites the command line; this path in the command
	// line is how processesMatching() counts instances.
	const longLivedCommand = join(dir, 'long-lived-stub');
	writeFileSync(longLivedCommand, '#!/usr/bin/env node\nsetInterval(() => {}, 60000);\n');
	chmodSync(longLivedCommand, 0o755);

	// Runnable, and deliberately left out of the allowlist, so a rejection can only
	// be the allowlist and not an exec failure. Stands in for the binary an
	// operator forgot to add to applications.allowedSpawnCommands.
	const deniedCommand = join(dir, 'denied-stub');
	writeFileSync(deniedCommand, '#!/usr/bin/env node\nprocess.exit(0);\n');
	chmodSync(deniedCommand, 0o755);

	return {
		dir,
		longLivedCommand,
		deniedCommand,
		resultsFile: join(dir, 'probe-results.jsonl'),
	};
}

/**
 * Assemble the Harper application under test inside the workspace.
 *
 * The committed fixture carries only the component entry. dd-supervisor.js and
 * the conf.d template it renders are copied from example/ here, so the example
 * stays the single source and the suite executes the shipped files. node_modules
 * is pre-seeded to reproduce what `npm install` gives a deployed component
 * (Harper sees node_modules and skips its own install, keeping the suite off
 * npm and the network):
 *
 * - the real package: this repo's package.json, version pin, dist/ and conf.d/;
 * - a generated platform package whose accessors return `binaries`. That keeps
 *   BinaryManager's production resolution path - the platform package accessor -
 *   the one under test, while the suite chooses what actually gets spawned.
 */
function assembleFixtureApp(
	workspace: Workspace,
	binaries: { core: string; trace: string },
	{ omitLogsTemplate = false } = {}
): string {
	const appDir = join(workspace.dir, APP_NAME);
	cpSync(FIXTURE_PATH, appDir, { recursive: true });
	cpSync(join(EXAMPLE_DIR, 'dd-supervisor.js'), join(appDir, 'dd-supervisor.js'));
	// The supervisor spawns this by absolute path inside the component directory, so an
	// assembled app without it has no reaper and the agents outlive the node.
	cpSync(join(EXAMPLE_DIR, 'dd-reaper.js'), join(appDir, 'dd-reaper.js'));
	// Omitted, not corrupted: an absent template is what an operator who renamed or
	// never created conf.d/harperdb.d/conf.yaml actually has.
	if (!omitLogsTemplate) cpSync(join(EXAMPLE_DIR, 'conf.d'), join(appDir, 'conf.d'), { recursive: true });

	const modulesDir = join(appDir, 'node_modules');
	const packageDir = join(modulesDir, ...PACKAGE_MANIFEST.name.split('/'));
	mkdirSync(packageDir, { recursive: true });
	cpSync(join(REPO_ROOT, 'package.json'), join(packageDir, 'package.json'));
	cpSync(join(REPO_ROOT, '.datadog-agent-version'), join(packageDir, '.datadog-agent-version'));
	cpSync(PACKAGE_DIST_DIR, join(packageDir, 'dist'), { recursive: true });
	// conf.d ships in the package's `files`, and the supervisor resolves the core-check
	// configurations through the package rather than through the component. Omit it here and
	// the suite proves nothing about host metrics while still going green: the supervisor
	// treats an unreadable conf.d as the optional feature it is and warns.
	cpSync(join(REPO_ROOT, 'conf.d'), join(packageDir, 'conf.d'), { recursive: true });
	// Harper skips its own install when node_modules exists, so anything the package
	// needs at runtime has to be staged here. Nothing is, because the package declares
	// no dependencies; a dependency added later would resolve on a developer's machine
	// and nowhere else.
	assert.deepEqual(
		Object.keys(PACKAGE_MANIFEST.dependencies ?? {}),
		[],
		'the package gained a runtime dependency, which this fixture does not copy into the assembled app'
	);

	// dist is the arbiter of the platform package's name and accessor contract,
	// so the stand-in cannot drift from what BinaryManager will call.
	const { Platform } = require(join(PACKAGE_DIST_DIR, 'platform.js'));
	const { platformPackageName } = require(join(PACKAGE_DIST_DIR, 'package-identity.js'));
	const platform = Platform.current();
	const packageName: string = platformPackageName(platform.getName());
	const platformPackageDir = join(modulesDir, ...packageName.split('/'));
	mkdirSync(platformPackageDir, { recursive: true });
	writeFileSync(
		join(platformPackageDir, 'package.json'),
		JSON.stringify(
			{ name: packageName, version: PACKAGE_MANIFEST.version, private: true, main: 'index.js' },
			null,
			'\t'
		) + '\n'
	);
	writeFileSync(
		join(platformPackageDir, 'index.js'),
		'// Generated by harper-spawn.test.ts: stands in for the platform package,\n' +
			"// keeping BinaryManager's production resolution path the one exercised\n" +
			'// while the suite chooses the executables it hands out.\n' +
			(['core', 'trace'] as const)
				.map((kind) => `exports.${platform.getBinary(kind).accessorName} = () => ${JSON.stringify(binaries[kind])};\n`)
				.join('')
	);
	return appDir;
}

/**
 * Environment for the Harper process. The DD_* variables are pinned (mostly to
 * the empty string, which the supervisor treats as unset) so the fingerprint it
 * hashes is deterministic and the missing-DD_API_KEY warning path executes
 * regardless of what the developer's shell exports.
 *
 * ROOTPATH is pinned empty for the same reason and one more: it is the first
 * candidate the supervisor's path resolution takes, so a developer who exports
 * it would silently move this run off the derivation under test. Cleared, the
 * only remaining source is the boot properties file Harper writes into the
 * isolated HOME, which is what the assertions below check.
 *
 * The return type is inferred from these keys rather than declared
 * `Record<string, string>`, under which reading a variable this no longer sets
 * typechecks as a `string` and arrives as `undefined`. That is how the launch
 * change and the path derivation passed separately and broke together: an
 * assertion still read DD_HARPER_RUNTIME_DIR out of here after the variable
 * stopped existing, and `join()` took the undefined at runtime.
 */
function supervisorEnv(workspace: Workspace) {
	return {
		DD_SPAWN_PROBE_DIR: workspace.dir,
		DD_SPAWN_PROBE_COMMAND: workspace.longLivedCommand,
		ROOTPATH: '',
		DD_API_KEY: '',
		DD_SITE: '',
		DD_ENV: '',
		DD_SERVICE: '',
	} satisfies Record<string, string>;
}

/**
 * Wait until every thread that is going to load the component has finished its
 * supervisor run. There is no way to know N up front (that is what the run is
 * measuring), so wait for the count of finished threads to stop changing.
 */
function waitForProbeResults(resultsFile: string, { settleMs = 2000 } = {}): Promise<ProbeRow[]> {
	// The supervisor holds its status promise open while it waits for the APM
	// receiver to answer, so a thread takes the receiver deadline plus its own start
	// time to report. The default 60s here used to be ample and no longer is.
	let lastCount = -1;
	let stableSince = Date.now();
	return pollJsonlRows<ProbeRow>(
		resultsFile,
		(rows) => {
			const finished = threadsThatProbed(rows);
			if (finished !== lastCount) {
				lastCount = finished;
				stableSince = Date.now();
				return false;
			}
			return finished > 0 && Date.now() - stableSince >= settleMs;
		},
		{ timeoutMs: 180000 }
	);
}

function supervisorStatuses(rows: ProbeRow[]): Array<{ threadId: number; status: SupervisorStatus }> {
	return rows.filter((r) => r.probe === 'status' && r.status).map((r) => ({ threadId: r.threadId, status: r.status! }));
}

function agentRow(status: SupervisorStatus, name: string): AgentRow | undefined {
	return status.agents.find((agent) => agent.name === name);
}

function threadsThatProbed(rows: ProbeRow[]): number {
	return new Set(rows.filter((r) => r.probe === 'done').map((r) => r.threadId)).size;
}

/** `<rootPath>/pids/<name>.pid`, the lock Harper takes to dedupe by name. */
function pidFilePath(dataRootDir: string, processName: string): string {
	return join(dataRootDir, 'pids', `${processName}.pid`);
}

/**
 * Both lines of Harper's PID file: line 1 the pid, line 2 the version recorded
 * when the spawn passed one (the example always does).
 */
function readPidRecord(dataRootDir: string, processName: string): { pid: number; version: number | null } | null {
	const path = pidFilePath(dataRootDir, processName);
	if (!existsSync(path)) return null;
	const lines = readFileSync(path, 'utf8').trim().split('\n');
	const pid = Number.parseInt(lines[0], 10);
	if (!Number.isFinite(pid)) return null;
	const version = lines.length > 1 ? Number.parseInt(lines[1], 10) : NaN;
	return { pid, version: Number.isFinite(version) ? version : null };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** PIDs of every live process whose command line contains `marker`. */
function processesMatching(marker: string): number[] {
	// -ww disables ps(1)'s width truncation, which would otherwise cut the mkdtemp
	// path we are matching on.
	const output = execFileSync('ps', ['-ww', '-Ao', 'pid=,command='], {
		encoding: 'utf8',
	});
	return output
		.split('\n')
		.filter((line) => line.includes(marker))
		.map((line) => Number.parseInt(line.trim().split(/\s+/)[0], 10))
		.filter((pid) => Number.isFinite(pid));
}

async function waitUntil(predicate: () => boolean, { timeoutMs = 15000, intervalMs = 100 } = {}): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

/**
 * Kill everything the supervisor may have started before the install dir (and
 * its PID files) go away, so nothing outlives the suite. The three sources
 * overlap on the happy path; each covers a failure mode the others miss (a stub
 * carries the workspace path, a real agent does not; PID files survive a thread
 * that never reported; rows survive teardownHarper deleting the PID files).
 */
async function teardown(
	ctx: ContextWithHarper,
	workspace: Workspace | undefined,
	rows: ProbeRow[] | undefined
): Promise<void> {
	if (workspace) {
		const pids = new Set<number>(processesMatching(workspace.dir));
		for (const { status } of supervisorStatuses(rows ?? [])) {
			for (const agent of status.agents) {
				if (typeof agent.pid === 'number' && agent.pid > 0) pids.add(agent.pid);
			}
			if (typeof status.reaper?.pid === 'number' && status.reaper.pid > 0) pids.add(status.reaper.pid);
		}
		if (ctx.harper?.dataRootDir) {
			for (const name of [...AGENT_NAMES, REAPER_NAME]) {
				const record = readPidRecord(ctx.harper.dataRootDir, name);
				if (record) pids.add(record.pid);
			}
		}
		for (const pid of pids) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
	}
	await teardownHarper(ctx);
	if (workspace) rmSync(workspace.dir, { recursive: true, force: true });
}

/**
 * node:test hands a suite callback a bare SuiteContext; setupHarperWithFixture()
 * populates .harper on that same object in before(). The cast records that
 * promotion; annotating the suite parameter itself is a TS2345 under strict
 * function-type contravariance.
 */
function harperContext(suiteContext: unknown): ContextWithHarper {
	return suiteContext as ContextWithHarper;
}

/**
 * Assemble the application, boot Harper against it, and wait for every thread's
 * probe output. `plan` chooses, per workspace, which executables the platform
 * package accessors hand out and which extra commands the allowlist carries;
 * the stub is always allowlisted, because the fixture's no-name probe spawns it
 * and that throw has to be the missing name rather than the allowlist.
 */
async function startSupervisorRun(
	ctx: ContextWithHarper,
	plan: (workspace: Workspace) => {
		binaries: { core: string; trace: string };
		alsoAllowed?: string[];
		omitLogsTemplate?: boolean;
	}
): Promise<{ workspace: Workspace; rows: ProbeRow[] }> {
	const workspace = createWorkspace();
	const { binaries, alsoAllowed = [], omitLogsTemplate = false } = plan(workspace);
	await setupHarperWithFixture(ctx, assembleFixtureApp(workspace, binaries, { omitLogsTemplate }), {
		harperBinPath: harperBinPath!,
		config: {
			threads: { count: REQUESTED_THREAD_COUNT },
			applications: {
				// Harper spawns `npm` and `node` itself (component dependency
				// installation), so the allowlist has to keep them. Replacing the list
				// wholesale with only the command under test breaks Harper's own
				// startup, not just the component.
				allowedSpawnCommands: ['npm', 'node', workspace.longLivedCommand, ...alsoAllowed],
			},
		},
		env: supervisorEnv(workspace),
	});
	return { workspace, rows: await waitForProbeResults(workspace.resultsFile) };
}

/**
 * Every reporting thread launched both agents, in the documented order, from
 * the path `binaryPathFor` names. Shared by the stub suite and the real-binary
 * suite: the same claim, against different executables.
 */
function assertAgentsLaunched(rows: ProbeRow[], binaryPathFor: (agent: AgentRow) => string): void {
	for (const { threadId, status } of supervisorStatuses(rows)) {
		// Order is part of the contract: the trace-agent owns the socket dd-trace
		// is already dialing, so it goes first.
		assert.deepEqual(
			status.agents.map((agent) => agent.name),
			AGENT_NAMES,
			`thread ${threadId}: the supervisor must request exactly these names, ` + `in this order`
		);
		for (const agent of status.agents) {
			assert.equal(agent.error, undefined, `thread ${threadId}: ${agent.name} failed: ${agent.error}`);
			assert.equal(agent.started, true, `thread ${threadId}: ${agent.name} did not start`);
			assert.ok(typeof agent.pid === 'number' && agent.pid > 0, `thread ${threadId}: ${agent.name} returned no pid`);
			assert.equal(
				agent.binaryPath,
				binaryPathFor(agent),
				`thread ${threadId}: ${agent.name} must be spawned from the path the ` +
					`platform package accessor resolved through BinaryManager`
			);
		}
	}
}

suite('the shipped example supervisor under Harper v5 spawn enforcement', { skip: SKIP_REASON }, (suiteContext) => {
	const ctx = harperContext(suiteContext);
	let workspace: Workspace;
	let rows: ProbeRow[];

	before(async () => {
		({ workspace, rows } = await startSupervisorRun(ctx, (ws) => ({
			binaries: { core: ws.longLivedCommand, trace: ws.longLivedCommand },
		})));
	});

	after(() => teardown(ctx, workspace, rows));

	test('the component loaded and every thread reported a status', () => {
		assert.ok(
			rows.length > 0,
			`no probe records were written to ${workspace.resultsFile}. The component ` +
				`did not load, so nothing below is testing the example.`
		);
		const threads = threadsThatProbed(rows);
		assert.ok(threads >= 1, 'no thread finished its supervisor run');
		assert.equal(
			supervisorStatuses(rows).length,
			threads,
			"every finished thread must have recorded the supervisor's status object"
		);
	});

	test('NEGATIVE: spawn without a `name` option throws', () => {
		const observed = rows.filter((row) => row.probe === 'no-name');
		assert.ok(observed.length > 0, 'the no-name probe never ran');
		for (const row of observed) {
			assert.equal(
				row.threw,
				true,
				`thread ${row.threadId}: spawn without a name SUCCEEDED. Stock Node ignores ` +
					`an unknown option and Harper v4 does not replace child_process at all, so ` +
					`this runtime is not enforcing anything and every assertion below is vacuous.`
			);
			// Specifically the missing-name error, not the allowlist one. Harper
			// checks the allowlist first, so a probe command that fell out of
			// applications.allowedSpawnCommands would throw for the wrong reason
			// and this assertion would still see `threw: true`.
			assert.match(
				row.error!,
				/process "name"/i,
				`thread ${row.threadId}: expected Harper's missing-name error, got: ${row.error}`
			);
		}
	});

	test("NEGATIVE: the example's startup probe sees its bogus command rejected", () => {
		// assertSpawnInterception() spawns a command that exists nowhere and is
		// allowlisted nowhere. Node's real spawn would return a ChildProcess and
		// report ENOENT asynchronously; only Harper's wrapper throws here.
		for (const { threadId, status } of supervisorStatuses(rows)) {
			assert.equal(
				status.interception.intercepted,
				true,
				`thread ${threadId}: the example decided Harper's constrained ` +
					`child_process is NOT active: ${status.interception.detail}`
			);
			assert.match(
				status.interception.detail,
				/is not allowed/i,
				`thread ${threadId}: interception was detected, but by an unexpected ` + `path: ${status.interception.detail}`
			);
		}
	});

	test('POSITIVE: both documented agent names launch, trace-agent first', () => {
		for (const { threadId, status } of supervisorStatuses(rows)) {
			assert.equal(status.error, undefined, `thread ${threadId}: supervisor startup failed: ${status.error}`);
		}
		assertAgentsLaunched(rows, () => workspace.longLivedCommand);
	});

	test('NEGATIVE: a trace-agent that binds nothing is reported as unbound, not as started', () => {
		// The stub stays alive and never opens a socket, which is the shape the
		// founding defect took: resolvable, spawned, running, and serving no spans.
		// `started: true` is true of it, and on its own it is the wrong answer.
		for (const { threadId, status } of supervisorStatuses(rows)) {
			const trace = agentRow(status, TRACE_AGENT_NAME);
			assert.equal(trace?.started, true, `thread ${threadId}: the trace-agent stub did not start`);
			assert.equal(
				trace?.receiverBound,
				false,
				`thread ${threadId}: nothing bound 127.0.0.1:${status.receiverPort}, so the ` +
					`status must say so rather than stopping at "started"`
			);
		}
	});

	test('SINGLETON: N worker threads produce one process and one PID file per name', (t) => {
		const threads = threadsThatProbed(rows);
		if (threads < 2) {
			// Not a pass. There was no race to observe, so the dedupe was never
			// exercised, and saying so is the only honest outcome.
			t.skip(
				`only ${threads} thread loaded the component (threads.count=${REQUESTED_THREAD_COUNT} ` +
					`was requested). Harper defaults to a single worker on macOS and Windows ` +
					`(without SO_REUSEPORT extra HTTP workers cannot share the server ports), ` +
					`and \`harper dev\` forces 1 via DEV_MODE. The PID-lock race needs at least 2 ` +
					`threads; run this on Linux, or with an explicit threads.count that the ` +
					`runtime honours.`
			);
			return;
		}

		const statuses = supervisorStatuses(rows);
		for (const name of AGENT_NAMES) {
			const observed = statuses.flatMap(({ status }) => {
				const agent = agentRow(status, name);
				return agent ? [agent] : [];
			});
			assert.equal(observed.length, threads, `${name}: every thread that reported should have attempted the launch`);

			// `adopted` is the supervisor's own spawnargs test: false means this
			// thread got a real ChildProcess, true means Harper handed it the
			// ExistingProcessWrapper for a process another thread started.
			const winners = observed.filter((agent) => agent.adopted === false);
			assert.equal(
				winners.length,
				1,
				`${name}: exactly one thread may win the PID-file lock and hold a real ` +
					`ChildProcess; ${winners.length} did. More than one means ${threads} ` +
					`copies of the agent per node.`
			);

			const pids = new Set(observed.map((agent) => agent.pid));
			assert.equal(
				pids.size,
				1,
				`${name}: every thread must end up holding the same pid (winner and ` +
					`losers alike); saw ${[...pids].join(', ')}`
			);

			const record = readPidRecord(ctx.harper.dataRootDir, name);
			assert.ok(record, `missing ${pidFilePath(ctx.harper.dataRootDir, name)}`);
			assert.equal(
				record!.pid,
				winners[0].pid,
				`${name}: ${pidFilePath(ctx.harper.dataRootDir, name)} must hold the pid ` +
					`of the one process that was started`
			);
			assert.ok(isAlive(record!.pid), `${name}: pid ${record!.pid} is not running`);
		}

		// The checks above are Harper's own bookkeeping. This one asks the OS.
		const running = processesMatching(workspace.longLivedCommand);
		assert.equal(
			running.length,
			2,
			`expected exactly two stub processes (one per name) across ${threads} ` +
				`threads, found ${running.length}: ${running.join(', ')}`
		);
	});

	test('the version fingerprint is one integer, shared by threads and recorded in the PID file', () => {
		const versions = new Set(supervisorStatuses(rows).map(({ status }) => status.version));
		assert.equal(
			versions.size,
			1,
			`threads disagreed about configVersion(): ${[...versions].join(', ')}. ` +
				`A disagreement makes each thread kill and respawn the other's agent, forever.`
		);
		const [version] = [...versions];
		assert.ok(
			typeof version === 'number' && Number.isInteger(version),
			`configVersion() must produce an integer: Harper parseInt()s line 2 of the ` +
				`PID file and compares with !==, so any other type never equals its own ` +
				`recorded value. Got: ${JSON.stringify(version)}`
		);
		for (const name of AGENT_NAMES) {
			const record = readPidRecord(ctx.harper.dataRootDir, name);
			assert.ok(record, `missing ${pidFilePath(ctx.harper.dataRootDir, name)}`);
			assert.equal(record!.version, version, `${name}: line 2 of the PID file must round-trip the fingerprint`);
		}
	});

	test('the node config file a real Harper writes is the one the docs name', () => {
		// The docs guard in test/unit/node-config-filename.test.js checks the documents
		// against each other, which cannot catch both of them being wrong together. This
		// checks them against a Harper that just wrote its own config. The harness boots
		// with --ROOTPATH and an isolated HOME, so getConfigFilePath() takes the
		// probe-by-name branch, which is the only branch where the filename decides
		// anything.
		const rootPath = ctx.harper.dataRootDir;
		assert.ok(
			existsSync(join(rootPath, 'harper-config.yaml')),
			`Harper wrote no harper-config.yaml into ${rootPath}. Every document in this ` +
				`repo tells the reader to edit that file; if Harper stopped writing it, they ` +
				`are all sending keys somewhere nothing reads.`
		);
		assert.ok(
			!existsSync(join(rootPath, 'harperdb-config.yaml')),
			'Harper wrote the legacy harperdb-config.yaml. The docs describe it as read only ' +
				'as a fallback for nodes carried over from the old harperdb package.'
		);
	});

	test("the runtime tree is rendered from the example's templates", () => {
		const [{ status }] = supervisorStatuses(rows);
		// Nothing in the Harper process's environment names either path: ROOTPATH is
		// pinned empty by supervisorEnv(). Both values can only have come from the
		// boot properties file, which is the derivation under test, running against a
		// Harper that wrote that file itself.
		const rootPath = ctx.harper.dataRootDir;
		assert.equal(status.runtimeDir, join(rootPath, 'datadog'));
		assert.equal(status.harperLogPath, join(rootPath, 'log', 'hdb.log'));
		assert.equal(status.service, 'harper', 'DD_SERVICE was empty, so the documented default applies');
		assert.equal(status.apiKey, 'MISSING', 'DD_API_KEY was empty; the supervisor must report that, not fail on it');

		const datadogYaml = readFileSync(join(status.runtimeDir!, 'datadog.yaml'), 'utf8');
		assert.match(datadogYaml, /receiver_port: 8126/, 'the generated datadog.yaml must carry the APM receiver port');

		const logsConfig = readFileSync(join(status.runtimeDir!, 'conf.d', 'harperdb.d', 'conf.yaml'), 'utf8');
		assert.ok(
			!logsConfig.includes('__HDB_LOG_PATH__') && !logsConfig.includes('__DD_SERVICE__'),
			'every placeholder in the shipped conf.d template must be substituted'
		);
		assert.ok(
			logsConfig.includes(status.harperLogPath!),
			'the logs source must tail the log path the supervisor derived'
		);

		// The collector schedules only what conf.d names. With nothing here but the log
		// source the agent runs no check at all, and says so nowhere useful: the forwarder
		// still posts datadog.agent.running, which the aggregator appends to every flush
		// rather than collecting, so the pipeline reports success while carrying nothing
		// about the host.
		assert.ok(
			Array.isArray(status.coreChecks) && status.coreChecks.includes('cpu'),
			`the supervisor reported no cpu check: ${JSON.stringify(status.coreChecks)}`
		);
		for (const name of status.coreChecks!) {
			assert.ok(
				existsSync(join(status.runtimeDir!, 'conf.d', `${name}.d`, 'conf.yaml.default')),
				`${name} was reported as configured but nothing was written for it`
			);
		}
	});

	test('killing the child unlinks its PID file', async () => {
		// Left last: it removes one of the processes the tests above assert on.
		// The example's exit handler tells operators "Harper has removed its PID
		// file, so the next worker will try again"; this is that claim, checked.
		const record = readPidRecord(ctx.harper.dataRootDir, TRACE_AGENT_NAME);
		assert.ok(record, 'no PID file to clean up');
		const path = pidFilePath(ctx.harper.dataRootDir, TRACE_AGENT_NAME);

		process.kill(record!.pid, 'SIGTERM');

		assert.ok(
			await waitUntil(() => !existsSync(path)),
			`${path} still exists after the process was killed. The 'exit' handler ` +
				`Harper attaches is what releases the name; a stale PID file whose process ` +
				`is gone blocks nothing, but one left holding a recycled pid would.`
		);
		assert.ok(
			existsSync(pidFilePath(ctx.harper.dataRootDir, CORE_AGENT_NAME)),
			"killing one agent must not release the other's lock"
		);
	});
});

suite(
	'the example surfaces an allowlist rejection without failing the component',
	{ skip: SKIP_REASON },
	(suiteContext) => {
		const ctx = harperContext(suiteContext);
		let workspace: Workspace;
		let rows: ProbeRow[];

		before(async () => {
			// The deployment bug this package shipped was an app that allowlisted the
			// one path it knew about. Resolve the trace-agent to a binary that is
			// missing from the allowlist and prove the example reports it per-agent
			// instead of taking the component down.
			({ workspace, rows } = await startSupervisorRun(ctx, (ws) => ({
				binaries: { core: ws.longLivedCommand, trace: ws.deniedCommand },
			})));
		});

		after(() => teardown(ctx, workspace, rows));

		test('NEGATIVE: the trace-agent is rejected, named, and takes no PID lock', () => {
			const statuses = supervisorStatuses(rows);
			assert.ok(statuses.length > 0, 'the component never reported a status');
			for (const { threadId, status } of statuses) {
				assert.equal(
					status.error,
					undefined,
					`thread ${threadId}: the rejection must be reported per-agent, not ` +
						`thrown out of startDatadogAgents(): ${status.error}`
				);
				const trace = agentRow(status, TRACE_AGENT_NAME);
				assert.ok(trace, `thread ${threadId}: no trace-agent entry in the status`);
				assert.equal(
					trace!.started,
					false,
					`thread ${threadId}: Harper spawned ${workspace.deniedCommand} although ` +
						`it is not in applications.allowedSpawnCommands`
				);
				assert.match(
					trace!.error ?? '',
					/is not allowed/i,
					`thread ${threadId}: expected Harper's allowlist error, got: ${trace!.error}`
				);
				assert.ok(
					trace!.error!.includes(workspace.deniedCommand),
					`thread ${threadId}: the error must name the exact path an operator has ` +
						`to add to the allowlist; got: ${trace!.error}`
				);
			}
			assert.equal(
				readPidRecord(ctx.harper.dataRootDir, TRACE_AGENT_NAME),
				null,
				'a rejected spawn must leave no PID file: Harper checks the allowlist ' +
					'before taking the lock, so nothing is there to block a corrected retry'
			);
			assert.equal(processesMatching(workspace.deniedCommand).length, 0, 'the denied stub must never actually run');
		});

		test("POSITIVE: the core agent is unaffected by its sibling's rejection", () => {
			for (const { threadId, status } of supervisorStatuses(rows)) {
				const core = agentRow(status, CORE_AGENT_NAME);
				assert.ok(core, `thread ${threadId}: no core agent entry in the status`);
				assert.equal(core!.started, true, `thread ${threadId}: the core agent should have started: ${core!.error}`);
				assert.ok(typeof core!.pid === 'number' && core!.pid > 0, `thread ${threadId}: the core agent returned no pid`);
			}
			const record = readPidRecord(ctx.harper.dataRootDir, CORE_AGENT_NAME);
			assert.ok(record, 'the core agent must still hold its PID lock');
			assert.ok(isAlive(record!.pid), `core pid ${record!.pid} is not running`);
		});
	}
);

suite('the example supervisor with the optional logs template missing', { skip: SKIP_REASON }, (suiteContext) => {
	const ctx = harperContext(suiteContext);
	let workspace: Workspace;
	let rows: ProbeRow[];

	before(async () => {
		({ workspace, rows } = await startSupervisorRun(ctx, (ws) => ({
			binaries: { core: ws.longLivedCommand, trace: ws.longLivedCommand },
			omitLogsTemplate: true,
		})));
	});

	after(() => teardown(ctx, workspace, rows));

	test('NEGATIVE: an unreadable logs template does not stop the trace-agent', () => {
		// Log collection is optional by the module's own account: the branch where no
		// log path could be resolved says "Traces are unaffected." Reading the template
		// happens first inside the same try, so a missing one used to set status.error
		// and launch neither agent.
		const statuses = supervisorStatuses(rows);
		assert.ok(statuses.length > 0, 'the component never reported a status');
		for (const { threadId, status } of statuses) {
			assert.equal(
				status.error,
				undefined,
				`thread ${threadId}: startup failed on an optional feature: ${status.error}`
			);
			assert.equal(
				status.agents.length,
				AGENT_NAMES.length,
				`thread ${threadId}: ${status.agents.length} agents were attempted; a logs ` +
					`template failure must not reach the spawns`
			);
		}
		assertAgentsLaunched(rows, () => workspace.longLivedCommand);
	});

	test('datadog.yaml is still written, and no logs source is', () => {
		// Derived the way the supervisor derives it, from the root path Harper recorded;
		// nothing in the environment names it. See supervisorEnv().
		const runtimeDir = join(ctx.harper.dataRootDir, 'datadog');
		assert.ok(
			existsSync(join(runtimeDir, 'datadog.yaml')),
			'the trace-agent is fatal without a config file that exists'
		);
		assert.equal(
			existsSync(join(runtimeDir, 'conf.d', 'harperdb.d', 'conf.yaml')),
			false,
			'nothing should have been rendered from a template that was not there'
		);
		assert.ok(
			existsSync(join(runtimeDir, 'conf.d', 'cpu.d', 'conf.yaml.default')),
			'the core-check configurations come from the package, not from the component ' +
				'template, so a missing logs template must not take host metrics with it'
		);
	});
});

/** Resolve both agent binaries the way a Harper application would. */
async function resolveAgentBinaries(): Promise<{ core: string; trace: string } | { error: string }> {
	try {
		const { BinaryManager } = require(join(REPO_ROOT, 'dist', 'binary-manager.js'));
		const manager = new BinaryManager();
		return {
			core: await manager.ensureBinary('core'),
			trace: await manager.ensureBinary('trace'),
		};
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

const agentBinaries = SKIP_REASON ? { error: SKIP_REASON } : await resolveAgentBinaries();

const BINARY_SKIP_REASON: string | false =
	SKIP_REASON ||
	('error' in agentBinaries
		? `the Datadog agent binaries are not available on this machine, so this suite ` +
			`cannot prove anything about them: ${agentBinaries.error}`
		: false);

suite(
	'the example supervisor launching the real Datadog agent binaries',
	{ skip: BINARY_SKIP_REASON },
	(suiteContext) => {
		const ctx = harperContext(suiteContext);
		const binaries = agentBinaries as { core: string; trace: string };
		let workspace: Workspace;
		let rows: ProbeRow[];

		before(async () => {
			({ workspace, rows } = await startSupervisorRun(ctx, () => ({
				binaries,
				alsoAllowed: [binaries.core, binaries.trace],
			})));
		});

		after(() => teardown(ctx, workspace, rows));

		test('both resolved paths are absolute and free of whitespace', () => {
			for (const [kind, binaryPath] of Object.entries(binaries)) {
				assert.ok(binaryPath.startsWith('/'), `${kind}: ${binaryPath} is not absolute`);
				assert.ok(
					!/\s/.test(binaryPath),
					`${kind}: ${binaryPath} contains whitespace. Harper's allowlist check is ` +
						`ALLOWED_COMMANDS.has(command.split(' ')[0]), so a path with a space can ` +
						`never match and the spawn is rejected however the allowlist is written.`
				);
			}
		});

		test('every thread detects interception and launches both real agents', () => {
			const statuses = supervisorStatuses(rows);
			assert.ok(statuses.length > 0, 'the component never reported a status');
			for (const { threadId, status } of statuses) {
				assert.equal(
					status.interception.intercepted,
					true,
					`thread ${threadId}: interception not detected: ${status.interception.detail}`
				);
			}
			const byKind: Record<string, string> = binaries;
			assertAgentsLaunched(rows, (agent) => byKind[agent.kind]);
		});

		test('some thread holds a real ChildProcess for each agent', () => {
			// ">= 1", not "exactly 1": a real agent may exit before slower threads
			// load (bad config, a busy 127.0.0.1:8126). Harper then unlinks its PID
			// file and a later thread wins a fresh lock, which is correct behaviour,
			// not a dedupe failure. The stub suite asserts the strict singleton.
			for (const name of AGENT_NAMES) {
				const winners = supervisorStatuses(rows).flatMap(({ status }) => {
					const agent = agentRow(status, name);
					return agent && agent.adopted === false ? [agent] : [];
				});
				assert.ok(
					winners.length >= 1,
					`${name}: no thread ever held a real ChildProcess (spawnargs present); ` +
						`every thread adopted, so who started the process?`
				);
			}
		});
	}
);

/**
 * Agent lifetime against the two events that must produce opposite outcomes.
 *
 * The defect: the agents outlive `harper stop`, leaving 127.0.0.1:8126 bound and PID files
 * naming live processes after the node that owns them is gone. The reason it was not already
 * fixed: agent lifetime is decoupled from the worker thread that won the spawn race on
 * purpose, because Harper recycles that thread and the agents must not die with it. So a
 * naive parent-exit handler reintroduces the bug it was written to prevent, and both halves
 * have to be proven on the same node.
 *
 * Its own Harper, because the second test kills it. `harper stop` is one SIGTERM to the PID
 * in `<root>/hdb.pid` (`bin/stop.js` reads it through `getHDBProcessInfo()` and runs
 * `kill <pid>`), so that is what is sent here rather than the harness's tree-wide teardown,
 * which would kill the agents itself and prove nothing.
 */
suite('agent lifetime across a worker recycle and a node shutdown', { skip: SKIP_REASON }, (suiteContext) => {
	const ctx = harperContext(suiteContext);
	let workspace: Workspace;
	let rows: ProbeRow[];
	/** PIDs observed while the node was up: two agents and the reaper. */
	let agentPids: number[];
	let reaperPid: number | undefined;

	before(async () => {
		({ workspace, rows } = await startSupervisorRun(ctx, (ws) => ({
			binaries: { core: ws.longLivedCommand, trace: ws.longLivedCommand },
		})));
		const records = AGENT_NAMES.map((name) => readPidRecord(ctx.harper.dataRootDir, name));
		agentPids = records.flatMap((record) => (record ? [record.pid] : []));
		reaperPid = readPidRecord(ctx.harper.dataRootDir, REAPER_NAME)?.pid;
	});

	after(() => teardown(ctx, workspace, rows));

	test('the node started exactly one reaper, and it is not counted as an agent', () => {
		for (const { threadId, status } of supervisorStatuses(rows)) {
			assert.ok(status.reaper, `thread ${threadId}: no reaper was reported`);
			assert.equal(
				status.reaper!.started,
				true,
				`thread ${threadId}: the reaper did not start (${status.reaper!.error}). Without it ` +
					`the agents outlive \`harper stop\`.`
			);
			// The suites above count agents and assert on the exact contents of `agents`.
			// A reaper folded into that list would break the singleton arithmetic and
			// silently change what "one core agent and one trace-agent" means.
			assert.deepEqual(
				status.agents.map((agent) => agent.name),
				AGENT_NAMES,
				`thread ${threadId}: the reaper must not appear in the agents list`
			);
		}
		const pids = new Set(supervisorStatuses(rows).map(({ status }) => status.reaper?.pid));
		assert.equal(pids.size, 1, `threads saw different reapers: ${[...pids].join(', ')}`);
		assert.ok(reaperPid && isAlive(reaperPid), `${REAPER_NAME}.pid does not name a live process`);
	});

	test('SURVIVES: a worker recycle leaves the agents and the reaper untouched', async () => {
		// `restart_service` with http_workers reaches `restartWorkers('http')` on the main
		// thread (`bin/restart.js`): the worker threads are replaced inside the same process.
		// That is the event agent lifetime was decoupled from, and the one a parent-exit
		// handler in the worker would have turned back into a kill.
		assert.equal(agentPids.length, 2, 'both agents must be running before the recycle');
		await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' });

		// Long enough for the replacement threads to load the component and run the
		// supervisor, which is when a broken decoupling would show.
		await sleep(8000);

		for (const pid of agentPids) {
			assert.ok(isAlive(pid), `agent pid ${pid} died on a worker recycle; it must survive one`);
		}
		assert.ok(isAlive(reaperPid!), `the reaper (pid ${reaperPid}) died on a worker recycle`);
		for (const name of [...AGENT_NAMES, REAPER_NAME]) {
			const record = readPidRecord(ctx.harper.dataRootDir, name);
			assert.ok(record, `${name}.pid was removed by a worker recycle`);
		}
		// The replacement threads adopted rather than started: same PIDs, so the node still
		// has one of each and the recycle cost nothing.
		assert.deepEqual(
			AGENT_NAMES.map((name) => readPidRecord(ctx.harper.dataRootDir, name)!.pid),
			agentPids,
			'the recycle replaced the agents instead of leaving them alone'
		);
	});

	test('DIES: the agents and the reaper exit when the node does, and take their PID files', async () => {
		const hdbPidFile = join(ctx.harper.dataRootDir, 'hdb.pid');
		assert.ok(existsSync(hdbPidFile), `${hdbPidFile} is missing, so there is no node PID to signal`);
		const harperPid = Number.parseInt(readFileSync(hdbPidFile, 'utf8').trim(), 10);
		assert.ok(isAlive(harperPid), `hdb.pid names ${harperPid}, which is not running`);

		// Exactly what `harper stop` sends: SIGTERM to that one PID. Not the process group,
		// which would kill the agents whether or not anything in this package worked.
		process.kill(harperPid, 'SIGTERM');
		assert.ok(await waitUntil(() => !isAlive(harperPid), { timeoutMs: 30000 }), 'Harper did not exit on SIGTERM');

		for (const pid of agentPids) {
			assert.ok(
				await waitUntil(() => !isAlive(pid), { timeoutMs: 40000 }),
				`agent pid ${pid} outlived the node. This is the defect: the process keeps ` +
					`127.0.0.1:8126 bound after the Harper that started it is gone.`
			);
		}
		assert.ok(
			await waitUntil(() => !isAlive(reaperPid!), { timeoutMs: 20000 }),
			'the reaper did not exit after reaping'
		);

		for (const name of [...AGENT_NAMES, REAPER_NAME]) {
			const file = pidFilePath(ctx.harper.dataRootDir, name);
			assert.ok(
				await waitUntil(() => !existsSync(file), { timeoutMs: 20000 }),
				`${file} was left behind naming a process that is gone`
			);
		}
	});
});
