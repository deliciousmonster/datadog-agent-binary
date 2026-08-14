/**
 * Harper v5 spawn enforcement, against a real Harper instance.
 *
 * This replaces scripts/harper-integration.sh, which booted `harperdb`: Harper
 * *v4*. v4's default config has no `applications` block and therefore no
 * `allowedSpawnCommands`, and v4 does not replace `node:child_process` for
 * component code at all. That script passed because nothing was checking, while
 * printing "executed under Harper v5 spawn enforcement". A suite that passes
 * because enforcement is absent is indistinguishable from one that passes because
 * the allowlist is right, so the first two assertions here are NEGATIVE: they
 * fail on any runtime that is not enforcing, which is what makes every later
 * assertion mean something.
 *
 * The harness is Harper's own (@harperfast/integration-testing): a temporary
 * install dir, a loopback address from a cross-process pool, and a real `harper`
 * process per suite.
 *
 * The second suite repeats the allowlist assertions against the real Datadog
 * binaries and skips cleanly when they have not been built, so the hermetic
 * suites under test/unit and test/e2e still cover a machine that has never run a
 * build.
 */
import { suite, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	setupHarperWithFixture,
	teardownHarper,
	type ContextWithHarper,
} from "@harperfast/integration-testing";

const require = createRequire(import.meta.url);

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURE_PATH = join(
	import.meta.dirname,
	"fixtures",
	"datadog-spawn-probe"
);

/**
 * The `harper` package's exports map only exposes ".", so the harness's
 * auto-resolution of 'harper/dist/bin/harper.js' fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package entry (which the map does
 * expose) and walk to the bin script from there. Same workaround
 * harperfast/application-template carries in its own tests.
 */
function resolveHarperBinPath(): string | null {
	try {
		return resolve(dirname(require.resolve("harper")), "bin/harper.js");
	} catch {
		return null;
	}
}

const harperBinPath = resolveHarperBinPath();

/**
 * Worker threads to ask for. macOS and Windows *default* to 1 (without
 * SO_REUSEPORT extra HTTP workers cannot share the server ports), and `harper
 * dev` forces 1 outright via DEV_MODE. An explicit threads.count still wins, and
 * the harness runs plain `harper`. The probe runs at component load, which
 * happens in every thread regardless of how HTTP traffic is routed. If the
 * runtime still gives us a single thread, the singleton test skips with the count
 * rather than passing vacuously against a race that never happened.
 */
const REQUESTED_THREAD_COUNT = 4;

/**
 * First address the harness's loopback pool hands out. Linux binds all of 127/8
 * out of the box; macOS configures only 127.0.0.1, so on a Mac without the alias
 * the harness's first bind dies in LoopbackAddressValidationError. That is a
 * missing prerequisite, not a failure, so probe it up front and skip.
 */
const LOOPBACK_POOL_START = Number.parseInt(
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START ?? "",
	10
);
const LOOPBACK_PROBE_ADDRESS = `127.0.0.${
	Number.isNaN(LOOPBACK_POOL_START) ? 2 : LOOPBACK_POOL_START
}`;

function canBindLoopbackAddress(address: string): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		// Port 0: the probe is about the address; any bindable port proves it.
		server.listen({ host: address, port: 0 }, () => {
			server.close(() => resolve(true));
		});
	});
}

const SKIP_REASON: string | false =
	process.platform === "win32"
		? "Harper spawn enforcement is exercised with a shebang'd stub executable and " +
			"counted with ps(1); neither works on Windows"
		: !harperBinPath
			? "the `harper` package is not installed; add harper and " +
				"@harperfast/integration-testing to devDependencies"
			: process.platform === "darwin" &&
				  !(await canBindLoopbackAddress(LOOPBACK_PROBE_ADDRESS))
				? `this machine cannot bind ${LOOPBACK_PROBE_ADDRESS}, the first address in ` +
					`the harness's loopback pool; macOS enables only 127.0.0.1 by default. ` +
					`Run \`sudo ifconfig lo0 alias ${LOOPBACK_PROBE_ADDRESS} up\` (or ` +
					`\`npx harper-integration-test-setup-loopback\` for the whole pool)`
				: false;

type ProbeRow = {
	threadId: number;
	probe: string;
	threw: boolean;
	error?: string;
	pid?: number | null;
	hasSpawnargs?: boolean;
	hasStdout?: boolean;
	hasKill?: boolean;
	hasUnref?: boolean;
};

/**
 * The stub executables and the probe's output. Kept outside the Harper install
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
	// realpath: on macOS os.tmpdir() lives under a /var -> /private/var symlink,
	// and the path recorded in ps(1) output is the resolved one.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ddab-harper-spawn-")));

	// Stays alive until killed; the interval is the only thing holding its event
	// loop open. It deliberately does NOT set process.title, which overwrites the
	// command line; this path in the command line is how processesMatching() counts
	// instances.
	const longLivedCommand = join(dir, "long-lived-stub");
	writeFileSync(
		longLivedCommand,
		"#!/usr/bin/env node\nsetInterval(() => {}, 60000);\n"
	);
	chmodSync(longLivedCommand, 0o755);

	// Runnable, and deliberately left out of the allowlist, so a rejection can only
	// be the allowlist and not an exec failure.
	const deniedCommand = join(dir, "denied-stub");
	writeFileSync(deniedCommand, "#!/usr/bin/env node\nprocess.exit(0);\n");
	chmodSync(deniedCommand, 0o755);

	return {
		dir,
		longLivedCommand,
		deniedCommand,
		resultsFile: join(dir, "probe-results.jsonl"),
	};
}

/**
 * Kill any stub still holding its event loop open before the install dir (and its
 * PID files) go away, so nothing outlives the suite.
 */
async function teardown(
	ctx: ContextWithHarper,
	workspace: Workspace | undefined
): Promise<void> {
	if (workspace) {
		for (const pid of processesMatching(workspace.dir)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
	await teardownHarper(ctx);
	if (workspace) rmSync(workspace.dir, { recursive: true, force: true });
}

function readProbeRows(resultsFile: string): ProbeRow[] {
	if (!existsSync(resultsFile)) return [];
	return readFileSync(resultsFile, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as ProbeRow];
			} catch {
				// A record is written in a single appendFileSync, so a torn line should
				// be impossible; tolerate one rather than failing on it.
				return [];
			}
		});
}

/**
 * Wait until every thread that is going to load the component has finished
 * probing. There is no way to know N up front (that is what the probe is
 * measuring), so wait for the count of finished threads to stop changing.
 */
async function waitForProbeResults(
	resultsFile: string,
	{ settleMs = 2000, timeoutMs = 60000 } = {}
): Promise<ProbeRow[]> {
	const deadline = Date.now() + timeoutMs;
	let lastCount = -1;
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const rows = readProbeRows(resultsFile);
		const finished = new Set(
			rows.filter((r) => r.probe === "done").map((r) => r.threadId)
		);
		if (finished.size !== lastCount) {
			lastCount = finished.size;
			stableSince = Date.now();
		} else if (finished.size > 0 && Date.now() - stableSince >= settleMs) {
			return rows;
		}
		await sleep(200);
	}
	return readProbeRows(resultsFile);
}

function rowsFor(rows: ProbeRow[], probe: string): ProbeRow[] {
	return rows.filter((r) => r.probe === probe);
}

function threadsThatProbed(rows: ProbeRow[]): number {
	return new Set(rows.filter((r) => r.probe === "done").map((r) => r.threadId))
		.size;
}

/** `<rootPath>/pids/<name>.pid`, the lock Harper takes to dedupe by name. */
function pidFilePath(dataRootDir: string, processName: string): string {
	return join(dataRootDir, "pids", `${processName}.pid`);
}

function readPidFile(dataRootDir: string, processName: string): number | null {
	const path = pidFilePath(dataRootDir, processName);
	if (!existsSync(path)) return null;
	const pid = Number.parseInt(
		readFileSync(path, "utf8").trim().split("\n")[0],
		10
	);
	return Number.isFinite(pid) ? pid : null;
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
	const output = execFileSync("ps", ["-ww", "-Ao", "pid=,command="], {
		encoding: "utf8",
	});
	return output
		.split("\n")
		.filter((line) => line.includes(marker))
		.map((line) => Number.parseInt(line.trim().split(/\s+/)[0], 10))
		.filter((pid) => Number.isFinite(pid));
}

async function waitUntil(
	predicate: () => boolean,
	{ timeoutMs = 15000, intervalMs = 100 } = {}
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

/**
 * Harper spawns `npm` and `node` itself (component dependency installation), so
 * the allowlist has to keep them. Replacing the list wholesale with only the
 * command under test breaks Harper's own startup, not just the probe.
 */
function allowlist(...commands: string[]): string[] {
	return ["npm", "node", ...commands];
}

const CORE_PROBE_NAME = "datadog-agent-probe";
const TRACE_PROBE_NAME = "datadog-trace-agent-probe";

suite(
	"Harper v5 spawn enforcement",
	{ skip: SKIP_REASON },
	(ctx: ContextWithHarper) => {
		let workspace: Workspace;
		let rows: ProbeRow[];

		before(async () => {
			workspace = createWorkspace();
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				harperBinPath: harperBinPath!,
				config: {
					threads: { count: REQUESTED_THREAD_COUNT },
					applications: {
						allowedSpawnCommands: allowlist(workspace.longLivedCommand),
					},
				},
				env: {
					DD_SPAWN_PROBE_DIR: workspace.dir,
					DD_SPAWN_PROBE_COMMAND: workspace.longLivedCommand,
					DD_SPAWN_PROBE_DENIED_COMMAND: workspace.deniedCommand,
					DD_SPAWN_PROBE_TARGETS: JSON.stringify([
						{
							name: CORE_PROBE_NAME,
							command: workspace.longLivedCommand,
							args: ["core"],
						},
						{
							name: TRACE_PROBE_NAME,
							command: workspace.longLivedCommand,
							args: ["trace"],
						},
					]),
				},
			});
			rows = await waitForProbeResults(workspace.resultsFile);
		});

		after(() => teardown(ctx, workspace));

		test("the component loaded and probed", () => {
			assert.ok(
				rows.length > 0,
				`no probe records were written to ${workspace.resultsFile}. The component ` +
					`did not load, so nothing below is testing enforcement.`
			);
			assert.ok(threadsThatProbed(rows) >= 1, "no thread finished its probes");
		});

		test("NEGATIVE: spawn without a `name` option throws", () => {
			const observed = rowsFor(rows, "no-name");
			assert.ok(observed.length > 0, "the no-name probe never ran");
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

		test("NEGATIVE: spawn of a non-allowlisted absolute path throws", () => {
			const observed = rowsFor(rows, "not-allowlisted");
			assert.ok(observed.length > 0, "the not-allowlisted probe never ran");
			for (const row of observed) {
				assert.equal(
					row.threw,
					true,
					`thread ${row.threadId}: spawning ${workspace.deniedCommand} was permitted ` +
						`although it is not in applications.allowedSpawnCommands`
				);
				assert.match(
					row.error!,
					/not allowed/i,
					`thread ${row.threadId}: expected Harper's allowlist error, got: ${row.error}`
				);
			}
		});

		test("POSITIVE: spawn of an allowlisted path with a name runs", () => {
			for (const name of [CORE_PROBE_NAME, TRACE_PROBE_NAME]) {
				const observed = rowsFor(rows, `allowlisted:${name}`);
				assert.ok(observed.length > 0, `the ${name} probe never ran`);
				for (const row of observed) {
					assert.equal(
						row.threw,
						false,
						`thread ${row.threadId}: ${name} was rejected: ${row.error}`
					);
					assert.ok(
						typeof row.pid === "number" && row.pid > 0,
						`thread ${row.threadId}: ${name} returned no pid`
					);
				}
			}
		});

		test("SINGLETON: N worker threads produce one process and one PID file", (t) => {
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

			for (const name of [CORE_PROBE_NAME, TRACE_PROBE_NAME]) {
				const observed = rowsFor(rows, `allowlisted:${name}`);
				assert.equal(
					observed.length,
					threads,
					`${name}: every thread that probed should have attempted the spawn`
				);

				const winners = observed.filter((r) => r.hasSpawnargs === true);
				assert.equal(
					winners.length,
					1,
					`${name}: exactly one thread may win the PID-file lock and actually spawn; ` +
						`${winners.length} did. More than one means ${threads} copies of the agent ` +
						`per node.`
				);

				const pids = new Set(observed.map((r) => r.pid));
				assert.equal(
					pids.size,
					1,
					`${name}: every thread must end up holding the same pid (winner and losers ` +
						`alike); saw ${[...pids].join(", ")}`
				);

				const filePid = readPidFile(ctx.harper.dataRootDir, name);
				assert.equal(
					filePid,
					winners[0].pid,
					`${name}: ${pidFilePath(ctx.harper.dataRootDir, name)} must hold the pid of ` +
						`the one process that was started`
				);
				assert.ok(isAlive(filePid!), `${name}: pid ${filePid} is not running`);
			}

			// The check above is Harper's own bookkeeping. This one asks the OS.
			const running = processesMatching(workspace.longLivedCommand);
			assert.equal(
				running.length,
				2,
				`expected exactly two stub processes (one per name) across ${threads} threads, ` +
					`found ${running.length}: ${running.join(", ")}`
			);
		});

		test("the loser of the race gets .pid but no .stdout", (t) => {
			const losers = [CORE_PROBE_NAME, TRACE_PROBE_NAME].flatMap((name) =>
				rowsFor(rows, `allowlisted:${name}`).filter(
					(r) => r.hasSpawnargs === false
				)
			);
			if (losers.length === 0) {
				const spawned = [CORE_PROBE_NAME, TRACE_PROBE_NAME].flatMap((name) =>
					rowsFor(rows, `allowlisted:${name}`).filter((r) => r.threw === false)
				).length;
				t.skip(
					`no thread lost the PID-file race: ${threadsThatProbed(rows)} thread(s) ` +
						`probed and ${spawned} spawn(s) succeeded, so no ExistingProcessWrapper ` +
						`was produced to inspect`
				);
				return;
			}
			for (const row of losers) {
				// Component code that does child.stdout.on(...) throws TypeError on
				// exactly these threads, which is why the launcher branches on
				// spawnargs before touching stdio.
				assert.ok(
					typeof row.pid === "number" && row.pid > 0,
					`thread ${row.threadId}: the wrapper must carry the running pid`
				);
				assert.equal(
					row.hasStdout,
					false,
					`thread ${row.threadId}: wrapper has no stdio`
				);
				assert.equal(
					row.hasKill,
					true,
					`thread ${row.threadId}: wrapper exposes kill()`
				);
				assert.equal(
					row.hasUnref,
					true,
					`thread ${row.threadId}: wrapper exposes unref()`
				);
			}
		});

		test("two distinct names yield two processes and two PID files", () => {
			// This is the whole reason the core agent and the trace-agent can both run
			// on one node: the lock is per `name`, not per command.
			const corePid = readPidFile(ctx.harper.dataRootDir, CORE_PROBE_NAME);
			const tracePid = readPidFile(ctx.harper.dataRootDir, TRACE_PROBE_NAME);

			assert.ok(
				corePid,
				`missing ${pidFilePath(ctx.harper.dataRootDir, CORE_PROBE_NAME)}`
			);
			assert.ok(
				tracePid,
				`missing ${pidFilePath(ctx.harper.dataRootDir, TRACE_PROBE_NAME)}`
			);
			assert.notEqual(
				corePid,
				tracePid,
				"the two names must lock independently and run as separate processes"
			);
			assert.ok(isAlive(corePid!), `core stub pid ${corePid} is not running`);
			assert.ok(
				isAlive(tracePid!),
				`trace stub pid ${tracePid} is not running`
			);
		});

		test("killing the child unlinks its PID file", async () => {
			// Left last: it removes one of the processes the tests above assert on.
			const pid = readPidFile(ctx.harper.dataRootDir, TRACE_PROBE_NAME);
			assert.ok(pid, "no PID file to clean up");
			const path = pidFilePath(ctx.harper.dataRootDir, TRACE_PROBE_NAME);

			process.kill(pid!, "SIGTERM");

			assert.ok(
				await waitUntil(() => !existsSync(path)),
				`${path} still exists after the process was killed. The 'exit' handler ` +
					`Harper attaches is what releases the name; a stale PID file whose process ` +
					`is gone blocks nothing, but one left holding a recycled pid would.`
			);
			assert.ok(
				existsSync(pidFilePath(ctx.harper.dataRootDir, CORE_PROBE_NAME)),
				"killing one agent must not release the other's lock"
			);
		});
	}
);

/**
 * Resolve both agent binaries the way a Harper application would. A version is
 * passed so the not-found path stops at the local build lookup instead of falling
 * through to getLatestVersion(), which calls the GitHub API; a skip must not
 * depend on the network.
 */
async function resolveAgentBinaries(): Promise<
	{ core: string; trace: string } | { error: string }
> {
	try {
		const { BinaryManager } = require(
			join(REPO_ROOT, "dist", "binary-manager.js")
		);
		const manager = new BinaryManager();
		return {
			core: await manager.ensureBinary("core", "not-a-published-version"),
			trace: await manager.ensureBinary("trace", "not-a-published-version"),
		};
	} catch (error: any) {
		return { error: String(error?.message ?? error) };
	}
}

const agentBinaries = SKIP_REASON
	? { error: SKIP_REASON }
	: await resolveAgentBinaries();

const BINARY_SKIP_REASON: string | false =
	SKIP_REASON ||
	("error" in agentBinaries
		? `the Datadog agent binaries are not available on this machine, so this suite ` +
			`cannot prove anything about them: ${agentBinaries.error}`
		: false);

suite(
	"Datadog agent binaries under Harper spawn enforcement",
	{ skip: BINARY_SKIP_REASON },
	(ctx: ContextWithHarper) => {
		const binaries = agentBinaries as { core: string; trace: string };
		let workspace: Workspace;
		let rows: ProbeRow[];

		before(async () => {
			workspace = createWorkspace();
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				harperBinPath: harperBinPath!,
				config: {
					threads: { count: REQUESTED_THREAD_COUNT },
					// Only the core agent is allowlisted alongside the probe command. The
					// trace-agent's rejection below is the assertion; the deployment bug
					// this package shipped was exactly an app that allowlisted the one
					// path it knew about.
					applications: {
						allowedSpawnCommands: allowlist(
							workspace.longLivedCommand,
							binaries.core
						),
					},
				},
				env: {
					DD_SPAWN_PROBE_DIR: workspace.dir,
					DD_SPAWN_PROBE_COMMAND: workspace.longLivedCommand,
					DD_SPAWN_PROBE_DENIED_COMMAND: binaries.trace,
					DD_SPAWN_PROBE_TARGETS: JSON.stringify([
						{
							name: "datadog-agent",
							command: binaries.core,
							args: ["version"],
						},
					]),
				},
			});
			rows = await waitForProbeResults(workspace.resultsFile);
		});

		after(() => teardown(ctx, workspace));

		test("both resolved paths are absolute and free of whitespace", () => {
			for (const [kind, binaryPath] of Object.entries(binaries)) {
				assert.ok(
					binaryPath.startsWith("/"),
					`${kind}: ${binaryPath} is not absolute`
				);
				assert.ok(
					!/\s/.test(binaryPath),
					`${kind}: ${binaryPath} contains whitespace. Harper's allowlist check is ` +
						`ALLOWED_COMMANDS.has(command.split(' ')[0]), so a path with a space can ` +
						`never match and the spawn is rejected however the allowlist is written.`
				);
			}
		});

		test("the core agent spawns when its absolute path is allowlisted", () => {
			const observed = rowsFor(rows, "allowlisted:datadog-agent");
			assert.ok(observed.length > 0, "the core agent probe never ran");
			for (const row of observed) {
				assert.equal(
					row.threw,
					false,
					`thread ${row.threadId}: Harper rejected ${binaries.core}: ${row.error}`
				);
				assert.ok(
					typeof row.pid === "number" && row.pid > 0,
					`thread ${row.threadId}: the core agent returned no pid`
				);
			}
		});

		test("the trace-agent is rejected when only the core agent is allowlisted", () => {
			// The two paths are checked independently by exact string equality.
			// Allowlisting the agent says nothing about the APM receiver, and the
			// failure mode when it is missed is silence: dd-trace connects to a closed
			// socket and drops every span without an error.
			const observed = rowsFor(rows, "not-allowlisted");
			assert.ok(observed.length > 0, "the trace-agent probe never ran");
			for (const row of observed) {
				assert.equal(
					row.threw,
					true,
					`thread ${row.threadId}: ${binaries.trace} was spawned although only ` +
						`${binaries.core} is in applications.allowedSpawnCommands`
				);
				assert.match(row.error!, /not allowed/i);
			}
		});
	}
);
