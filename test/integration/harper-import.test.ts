/**
 * Native importability of the PUBLISHED package inside Harper v5.
 *
 * Harper's security/jsLoader.ts claims a package for its application loader
 * when packageDependsOnHarper() finds a claimed module id in the dependencies,
 * devDependencies, or peerDependencies of the package's installed manifest.
 * Wave 1 removed "harper" from this repo's devDependencies for exactly that
 * reason. The hermetic guard on the manifest lives in
 * test/unit/harper-loader-claim.test.js; this suite installs the tarball npm
 * would publish into a real Harper application and proves the consequence.
 *
 * Measured on harper 5.2.1 by flipping `harper` in the staged manifest's
 * devDependencies: a claimed package still RESOLVES from component code, but
 * as a separate evaluation inside the application loader rather than the copy
 * in Node's module cache. Two evaluations mean divergent class identities and
 * duplicated module state, which is how the loader break surfaces in practice.
 * The identity probe below is therefore the assertion that actually trips when
 * someone re-adds harper; the export-shape assertions are the backstop for the
 * harder failure where the claimed import stops resolving at all.
 *
 * The harness and skip conditions follow test/integration/harper-spawn.test.ts:
 * Harper's own @harperfast/integration-testing, a loopback address from a
 * cross-process pool, a real `harper` process, and a probe that runs at
 * component load and writes JSONL for the test to read back.
 */
import { suite, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import {
	setupHarperWithFixture,
	teardownHarper,
	type ContextWithHarper,
} from "@harperfast/integration-testing";
import {
	darwinLoopbackSkipReason,
	errorMessage,
	readJsonlRows,
	resolveHarperBinPath,
} from "./support/harness.ts";

const require = createRequire(import.meta.url);

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PACKAGE_MANIFEST = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf8")
);
// Derived from the manifest, not hardcoded, so a re-scope cannot leave this
// suite proving importability of a name the package no longer publishes under.
const PACKAGE_NAME: string = PACKAGE_MANIFEST.name;

/**
 * The 5.2.1 baseline unioned with the installed harper's live list, shared
 * with test/unit/harper-loader-claim.test.js. That test scans the repo
 * manifest while the assertion below scans the packed artifact, which only
 * this suite has in hand; the id list itself is one module because a copy
 * here froze at the 5.2.1 baseline while the unit guard tracked upstream.
 * The skip guard below requires harper to be installed whenever this suite
 * runs, so the live derivation is always available to it.
 */
const { claimedIds } = require("../support/harper-claimed-ids.js") as {
	claimedIds: () => Set<string>;
};

const harperBinPath = resolveHarperBinPath();

// Same prerequisites as harper-spawn.test.ts; only the win32 reason differs,
// because what breaks there differs.
const SKIP_REASON: string | false =
	process.platform === "win32"
		? "the pack-and-install staging invokes `npm` via execFileSync, which on " +
			"Windows needs npm.cmd and a shell; this suite is wired for POSIX only"
		: !harperBinPath
			? "the `harper` package is not installed; add harper and " +
				"@harperfast/integration-testing to devDependencies"
			: await darwinLoopbackSkipReason();

type ProbeRow = {
	probe: string;
	threw: boolean;
	error?: string;
	hasResource?: boolean;
	hasTables?: boolean;
	exportKeys?: number;
	hasDatadogAgentBuilder?: boolean;
	hasBinaryManager?: boolean;
	builderHasBuildForPlatform?: boolean;
	sameClass?: boolean;
};

/**
 * Runs at component load inside Harper and records to JSONL, following the
 * datadog-spawn-probe fixture. Written from a string here instead of a checked
 * in fixture because the application directory only exists after the tarball
 * install stages it.
 */
const PROBE_SOURCE = `/**
 * Written by harper-import.test.ts at staging time; see that file.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = process.env.DD_IMPORT_PROBE_DIR;

function record(entry) {
	appendFileSync(join(PROBE_DIR, "probe-results.jsonl"), JSON.stringify(entry) + "\\n");
}

async function probe(name, run) {
	try {
		record({ probe: name, threw: false, ...(await run()) });
	} catch (error) {
		record({ probe: name, threw: true, error: String(error?.message ?? error) });
	}
}

if (PROBE_DIR) {
	// An async IIFE instead of top-level await: the loader's TLA support is not
	// what is under test, and the suite polls the results file for "done".
	(async () => {
		// Only Harper's application loader resolves 'harper' to its synthetic
		// module; under plain Node this import fails. Every probe below is
		// meaningless unless this row shows the loader mediating our imports.
		await probe("harper-module", async () => {
			const harper = await import("harper");
			return {
				hasResource: typeof harper.Resource === "function",
				hasTables: "tables" in harper,
			};
		});
		// 'harper/*' subpaths are reserved and must be refused; the refusal is
		// the second enforcement signal.
		await probe("harper-subpath", async () => {
			await import("harper/loader-probe");
			return {};
		});
		await probe("native-import", async () => {
			const mod = await import(${JSON.stringify(PACKAGE_NAME)});
			return {
				exportKeys: Object.keys(mod).length,
				hasDatadogAgentBuilder: typeof mod.DatadogAgentBuilder === "function",
				hasBinaryManager: typeof mod.BinaryManager === "function",
				builderHasBuildForPlatform:
					typeof mod.DatadogAgentBuilder?.prototype?.buildForPlatform === "function",
			};
		});
		// createRequire reaches Node's real CJS cache. A natively loaded package
		// shares one evaluation with it; a package claimed by the application
		// loader is a separate compartment evaluation, so the class identities
		// split. Verified in both directions against harper 5.2.1 by flipping
		// \`harper\` in the staged manifest's devDependencies.
		await probe("native-identity", async () => {
			const mod = await import(${JSON.stringify(PACKAGE_NAME)});
			const { createRequire } = await import("node:module");
			const viaRequire = createRequire(import.meta.url)(${JSON.stringify(PACKAGE_NAME)});
			return {
				sameClass: viaRequire.DatadogAgentBuilder === mod.DatadogAgentBuilder,
			};
		});
		record({ probe: "done", threw: false });
	})();
}
`;

// config.yaml replaces Harper's default component config entirely (no merge);
// the probe needs only its one module, loaded at startup in every thread.
const FIXTURE_CONFIG = "jsResource:\n  files: resources.js\n";

type ImportFixture = { workDir: string; appDir: string };

/**
 * Pack this repo the way npm publish would and install the tarball into a
 * minimal Harper application directory. The application's own manifest keeps
 * dependencies empty so Harper has no reason to run its own npm install;
 * node_modules is staged here and standard resolution finds the package in it.
 */
function buildImportFixture(): ImportFixture | { error: string } {
	// files[] ships dist/; packing without it would produce a tarball whose main
	// cannot resolve, and this suite would then be testing a broken artifact.
	if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
		return {
			error:
				"dist/index.js is missing; run `npm run build` so npm pack has the " +
				"compiled entry the published package ships",
		};
	}
	// realpath: os.tmpdir() on macOS lives under a /var -> /private/var symlink.
	const workDir = realpathSync(
		mkdtempSync(join(tmpdir(), "ddab-harper-import-"))
	);
	try {
		// --ignore-scripts: `prepare` runs husky, which contributes nothing to
		// pack contents and would couple this suite to git hook setup.
		const packed = JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--ignore-scripts", "--pack-destination", workDir],
				{ cwd: REPO_ROOT, encoding: "utf8" }
			)
		) as Array<{ filename: string }>;
		const tarball = join(workDir, packed[0].filename);

		const appDir = join(workDir, "app");
		mkdirSync(appDir);
		writeFileSync(
			join(appDir, "package.json"),
			JSON.stringify(
				{
					name: "datadog-import-probe",
					version: "0.0.0",
					private: true,
					type: "module",
					description:
						"Harper application that imports the packed " +
						PACKAGE_NAME +
						" natively at component load and records the outcome for " +
						"test/integration/harper-import.test.ts to assert on.",
					dependencies: {},
				},
				null,
				"\t"
			) + "\n"
		);
		writeFileSync(join(appDir, "config.yaml"), FIXTURE_CONFIG);
		writeFileSync(join(appDir, "resources.js"), PROBE_SOURCE);

		// --offline: the tarball is a file: spec and its runtime dependencies are
		// this repo's own, so `npm ci` already put them in the npm cache; a cache
		// miss must surface as a skip, never a network fetch. --omit=optional:
		// the platform binary packages are registry-only and import resolution
		// never needs them.
		execFileSync(
			"npm",
			[
				"install",
				tarball,
				"--no-save",
				"--no-package-lock",
				"--offline",
				"--omit=optional",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: appDir, encoding: "utf8" }
		);
		return { workDir, appDir };
	} catch (error) {
		rmSync(workDir, { recursive: true, force: true });
		return { error: errorMessage(error) };
	}
}

const importFixture = SKIP_REASON
	? { error: SKIP_REASON }
	: buildImportFixture();

const IMPORT_SKIP_REASON: string | false =
	SKIP_REASON ||
	("error" in importFixture
		? `the published tarball could not be staged into a Harper application, so ` +
			`there is nothing to import: ${importFixture.error}`
		: false);

/**
 * The probe writes "done" last, so its presence means every earlier record has
 * landed; no settle window is needed the way the multi-thread spawn suite
 * needs one.
 */
async function waitForProbeResults(
	resultsFile: string,
	{ timeoutMs = 60000 } = {}
): Promise<ProbeRow[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = readJsonlRows<ProbeRow>(resultsFile);
		if (rows.some((row) => row.probe === "done")) return rows;
		await sleep(200);
	}
	return readJsonlRows<ProbeRow>(resultsFile);
}

function rowFor(rows: ProbeRow[], probe: string): ProbeRow | undefined {
	return rows.find((row) => row.probe === probe);
}

suite(
	"Harper v5 native import of the published package",
	{ skip: IMPORT_SKIP_REASON },
	(suiteContext) => {
		// Same SuiteContext promotion as harper-spawn.test.ts: before() populates
		// .harper on this object.
		const ctx = suiteContext as ContextWithHarper;
		const fixture = importFixture as ImportFixture;
		let rows: ProbeRow[];

		before(async () => {
			await setupHarperWithFixture(ctx, fixture.appDir, {
				harperBinPath: harperBinPath!,
				env: { DD_IMPORT_PROBE_DIR: fixture.workDir },
			});
			rows = await waitForProbeResults(
				join(fixture.workDir, "probe-results.jsonl")
			);
		});

		after(async () => {
			await teardownHarper(ctx);
			rmSync(fixture.workDir, { recursive: true, force: true });
		});

		test("the installed manifest is the packed one, devDependencies intact", () => {
			const manifest = JSON.parse(
				readFileSync(
					join(fixture.appDir, "node_modules", PACKAGE_NAME, "package.json"),
					"utf8"
				)
			);
			assert.equal(manifest.name, PACKAGE_NAME);
			assert.equal(
				manifest.version,
				PACKAGE_MANIFEST.version,
				"the staged install does not hold the tarball this run packed, so the " +
					"import below would prove nothing about the artifact npm publishes"
			);
			// devDependencies surviving the pack is the premise of this whole suite:
			// it is why a stray harper entry there reaches consumers at all.
			assert.ok(
				manifest.devDependencies &&
					Object.keys(manifest.devDependencies).length > 0,
				"the packed manifest carries no devDependencies although the repo " +
					"manifest has them; npm has changed what it publishes and the " +
					"loader-claim guards should be re-derived against that behaviour"
			);
			// packageDependsOnHarper() merges exactly these three keys of exactly
			// this file. The repo-manifest scan in the unit test cannot see pack-time
			// rewrites; this can.
			const merged = {
				...manifest.dependencies,
				...manifest.devDependencies,
				...manifest.peerDependencies,
			};
			for (const id of claimedIds()) {
				assert.ok(
					!(id in merged),
					`the packed manifest names ${id}; Harper's loader will claim the ` +
						`package and the native import this suite asserts on will break`
				);
			}
		});

		test("the component loaded and probed", () => {
			assert.ok(
				rows.length > 0,
				`no probe records were written to ${join(fixture.workDir, "probe-results.jsonl")}. ` +
					`The component did not load, so nothing below is testing the loader.`
			);
			assert.ok(rowFor(rows, "done"), "the probe never finished");
		});

		test("NEGATIVE: the probes ran under Harper's loader, not plain Node", () => {
			const harperModule = rowFor(rows, "harper-module");
			assert.ok(harperModule, "the harper-module probe never ran");
			assert.equal(
				harperModule.threw,
				false,
				`importing 'harper' failed (${harperModule.error}); the component is ` +
					`not running under Harper's application loader and the native-import ` +
					`result below would be vacuous`
			);
			assert.equal(
				harperModule.hasResource,
				true,
				"the 'harper' module lacks the Resource class, so this is not " +
					"Harper's synthetic module"
			);
			assert.equal(harperModule.hasTables, true);

			// The reserved-subpath refusal is the loader speaking in its own voice;
			// a runtime that resolved it would not be enforcing anything.
			const subpath = rowFor(rows, "harper-subpath");
			assert.ok(subpath, "the harper-subpath probe never ran");
			assert.equal(
				subpath.threw,
				true,
				"import of a reserved 'harper/*' subpath was permitted"
			);
			assert.match(
				subpath.error!,
				/may only access the 'harper' module/i,
				`expected Harper's reserved-subpath error, got: ${subpath.error}`
			);
		});

		test("component code natively imports the published package", () => {
			const nativeImport = rowFor(rows, "native-import");
			assert.ok(nativeImport, "the native-import probe never ran");
			assert.equal(
				nativeImport.threw,
				false,
				`\`await import("${PACKAGE_NAME}")\` failed inside Harper: ` +
					`${nativeImport.error}. Either the staged tarball is broken (missing ` +
					`dist/, unresolvable runtime dependency) or the loader now refuses ` +
					`the package outright; the loader-claim case that still resolves is ` +
					`caught by the identity assertion below.`
			);
			// Known exports, not just a resolvable specifier: a claimed or shimmed
			// module could resolve and still not be this package.
			assert.equal(
				nativeImport.hasDatadogAgentBuilder,
				true,
				"DatadogAgentBuilder is missing from the imported module"
			);
			assert.equal(
				nativeImport.hasBinaryManager,
				true,
				"BinaryManager is missing; the star re-exports of dist/index.js did " +
					"not survive the import path Harper used"
			);
			assert.equal(
				nativeImport.builderHasBuildForPlatform,
				true,
				"DatadogAgentBuilder.prototype.buildForPlatform is not a function"
			);
		});

		test("NEGATIVE: the import is the native evaluation, not a loader copy", () => {
			// On harper 5.2.1 a claimed package still resolves with the same export
			// shape, so the shape assertions above stay green through the exact
			// regression this suite exists for. Identity does not: the application
			// loader evaluates its own copy, and this is the assertion that trips.
			const identity = rowFor(rows, "native-identity");
			assert.ok(identity, "the native-identity probe never ran");
			assert.equal(
				identity.threw,
				false,
				`the identity probe failed outright: ${identity.error}`
			);
			assert.equal(
				identity.sameClass,
				true,
				`\`import("${PACKAGE_NAME}")\` and a createRequire() of the same ` +
					`specifier returned different DatadogAgentBuilder classes. Harper's ` +
					`application loader has claimed the package, which is what ` +
					`packageDependsOnHarper() does when a claimed module id (harper, ` +
					`@harperfast/harper, ...) appears in any of the published manifest's ` +
					`dependencies/devDependencies/peerDependencies; devDependencies ship ` +
					`in the tarball. Two evaluations mean split singletons and ` +
					`instanceof failures for every consumer. See ` +
					`test/unit/harper-loader-claim.test.js and remove the entry.`
			);
		});
	}
);
