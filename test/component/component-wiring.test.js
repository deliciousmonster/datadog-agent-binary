// A component can load, run, and supervise nothing. `jsResource` compiles resources.js and hands it no Scope;
// `pluginModule` is what does, and only for a component the node's root config names. Both halves are
// invisible at runtime until the 60s deadline fires, so they are asserted here instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadComponent, REPO_ROOT } from "../support/component.js";
import { withEnvs, withHome, withTempDir } from "../support/sandbox.js";
import { captureLogs } from "../support/loopback.js";

const read = (...parts) =>
	fs.readFileSync(path.join(REPO_ROOT, ...parts), "utf8");
const manifest = JSON.parse(read("package.json"));

test("NEGATIVE: config.yaml carries pluginModule, without which the plugin is never called", () => {
	const config = read("config.yaml");

	assert.match(
		config,
		/^pluginModule:\s*resources\.js\s*$/m,
		"under jsResource alone Harper compiles resources.js for its resources and discards the module, so handleApplication never runs and nothing is supervised"
	);
	assert.match(
		config,
		/^jsResource:\s*\n\s+files:\s*resources\.js\s*$/m,
		"jsResource is what makes resources.js the entry the application loader compiles"
	);
	assert.match(
		config,
		/^rest:\s*true\s*$/m,
		"without rest the status resource has no route and the only view of startup is the log"
	);
});

test("every file the component reads at runtime is in the published package", () => {
	const shipped = new Set(manifest.files);
	for (const file of [
		"config.yaml",
		"resources.js",
		"probe.js",
		"agent-exit.js",
		"conf.d/",
	]) {
		assert.ok(
			shipped.has(file),
			`${file} is read at runtime and would not be in the tarball`
		);
	}
	// The core checks are the difference between an agent that collects host metrics and one that reports
	// healthy and collects nothing, so an empty conf.d/ ships as silently as a missing one.
	const checks = fs
		.readdirSync(path.join(REPO_ROOT, "conf.d"))
		.filter((entry) => entry.endsWith(".d"));
	assert.ok(checks.length >= 6, `only ${checks.length} core checks ship`);
	for (const check of checks) {
		assert.ok(
			fs.existsSync(path.join(REPO_ROOT, "conf.d", check, "conf.yaml.default")),
			`${check} ships without the conf.yaml.default that configures it`
		);
	}
});

test("NEGATIVE: the platform package the component resolves is derived from this package's name", async () => {
	const { resolveBinary } = await loadComponent();
	// A scope rename that missed resources.js resolves a package that does not exist, and the component
	// reports no binary on a node where the binary is installed.
	await assert.rejects(
		() => resolveBinary({ shipsAs: "no-such-agent", title: "nothing" }),
		(error) => {
			assert.ok(
				error.message.includes(`${manifest.name}-`),
				`the component looks for platform packages under a different name than ${manifest.name}: ${error.message}`
			);
			return true;
		}
	);
});

test("the runtime tree comes from Harper, not from a variable this package invents", async () => {
	const { prepareRuntime } = await loadComponent();

	await withTempDir("dd-root-", async (root) => {
		const fromEnv = await withEnvs({ ROOTPATH: root }, () =>
			prepareRuntime(REPO_ROOT)
		);
		assert.equal(fromEnv.paths.runtimeDir, path.join(root, "datadog"));
	});

	// Harper's own chain: hdb_boot_properties.file names the settings file, which carries rootPath.
	await withTempDir("dd-home-", async (home) => {
		const settings = path.join(home, "harper-config.yaml");
		const declared = path.join(home, "declared-root");
		fs.mkdirSync(path.join(home, ".harperdb"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".harperdb", "hdb_boot_properties.file"),
			`\tsettings_path=${settings}\n`
		);
		fs.writeFileSync(settings, `rootPath: ${declared}\noperationsApi:\n`);

		const runtime = await withEnvs({ ROOTPATH: undefined }, () =>
			withHome(home, () => prepareRuntime(REPO_ROOT))
		);
		assert.equal(runtime.paths.runtimeDir, path.join(declared, "datadog"));

		// Harper's own defaultConfig.yaml ships `rootPath: null`, which is not a path.
		fs.writeFileSync(settings, "rootPath: null\n");
		const nulled = await withEnvs({ ROOTPATH: undefined }, () =>
			withHome(home, () => prepareRuntime(REPO_ROOT))
		);
		assert.notEqual(
			nulled.paths.runtimeDir,
			path.join("null", "datadog"),
			"`rootPath: null` was taken for a directory name"
		);
	});
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Load with the module's own 60s start deadline shortened, so the real timer decides rather than the test. */
async function withShortDeadline(run) {
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (callback, ms, ...rest) =>
		realSetTimeout(callback, ms === 60_000 ? 20 : ms, ...rest);
	try {
		return await run();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
}

test("NEGATIVE: a component the plugin is never called for reports it, and names the root-config entry", async () => {
	// The one failure the module cannot see from inside: Harper imports it for its resources and never calls
	// the plugin, which is exactly what a directory found by scanning componentsRoot gets.
	const reported = await captureLogs(async () => {
		await withShortDeadline(() => loadComponent());
		await settle(80);
	});
	assert.ok(
		reported.some((line) => line.includes(`package: "${manifest.name}"`)),
		`the report has to carry the harper-config.yaml entry that fixes it; logged: ${JSON.stringify(reported)}`
	);

	// Being called at all disarms it, a validation load included: Harper reached the plugin either way.
	const quiet = await captureLogs(async () => {
		const component = await withShortDeadline(() => loadComponent());
		component.handleApplication({ isTransientValidation: true });
		await settle(80);
	});
	assert.deepEqual(
		quiet,
		[],
		"a node whose plugin Harper does call is told it was never called"
	);
});
