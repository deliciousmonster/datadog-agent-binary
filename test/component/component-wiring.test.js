// A component can load, run, and supervise nothing. `jsResource` compiles resources.js and hands it no Scope;
// `pluginModule` is what does, and only for a component the node's root config names. Both halves are
// invisible at runtime until the 60s deadline fires, so they are asserted here instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { resolveBinary } from "../../runtime/binary.js";
import { loadComponent, REPO_ROOT } from "../support/component.js";
import {
	withEnvs,
	withHome,
	withPatchedSetTimeout,
	withTempDir,
} from "../support/sandbox.js";
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

/**
 * Every local file reachable from `entries` by import, as repo-relative posix paths. Matches a static
 * `from "..."` specifier and a dynamic `import("...")` call, in both cases only a literal relative path:
 * runtime/binary.js's `import(platformPackage)` names an external optional dependency built from a
 * variable, so it resolves to no local file and correctly falls outside this walk rather than being missed by it.
 */
function importedFrom(...entries) {
	const seen = new Set();
	const walk = (file) => {
		const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
		if (seen.has(relative)) return;
		seen.add(relative);
		// A specifier resolving to nothing is still recorded, so it is reported as unshipped rather than
		// thrown as a read error that names no cause.
		if (!fs.existsSync(file)) return;
		for (const [, specifier] of fs
			.readFileSync(file, "utf8")
			.matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) {
			walk(path.resolve(path.dirname(file), specifier));
		}
	};
	for (const entry of entries) walk(path.join(REPO_ROOT, entry));
	return [...seen];
}

/** Whether `files` ships this path: an exact entry, or a directory entry above it. */
const ships = (files, relative) =>
	files.some((entry) =>
		entry.endsWith("/") ? relative.startsWith(entry) : entry === relative
	);

test("every file the component and the shim read at runtime is in the published package", () => {
	for (const file of ["config.yaml", "conf.d/"]) {
		assert.ok(
			manifest.files.includes(file),
			`${file} is read at runtime and would not be in the tarball`
		);
	}
	// Walked rather than listed, from both shipped entries: a helper added under runtime/ is covered by the
	// directory entry, one added beside resources.js is not, and an import of dist/ reaches build output the
	// tarball no longer carries. A list of known names catches none of the three.
	const imported = importedFrom("resources.js", "bin/datadog-agent");
	assert.ok(
		imported.length > 6 && imported.includes("guard/src/index.js"),
		`the walk reached ${imported.length} files and cannot have followed the component's imports: ${JSON.stringify(imported)}`
	);
	for (const file of imported) {
		assert.ok(
			ships(manifest.files, file),
			`${file} is imported at runtime and would not be in the tarball`
		);
	}
	// A submodule is a gitlink, so a clone without `submodules: true` leaves guard/ present and empty and
	// every boot fails on the import instead of here, which is the failure this gate exists to move forward.
	const guardEntry = path.join(REPO_ROOT, "guard", "src", "index.js");
	assert.ok(
		fs.existsSync(guardEntry) && fs.statSync(guardEntry).size > 0,
		"guard/src/index.js is missing or empty: run `git submodule update --init`, or the fallback supervisor cannot be imported at all"
	);
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
	// A scope rename that missed the resolver looks for a package that does not exist, and the component
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
	// Named by the component's own directory, so two installs of this plugin under different
	// component names get different pidDirs instead of fighting over one guard lock.
	const appName = path.basename(REPO_ROOT);

	await withTempDir("dd-root-", async (root) => {
		const fromEnv = await withEnvs({ ROOTPATH: root }, () => prepareRuntime());
		assert.equal(fromEnv.paths.runtimeDir, path.join(root, "datadog", appName));
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
			withHome(home, () => prepareRuntime())
		);
		assert.equal(
			runtime.paths.runtimeDir,
			path.join(declared, "datadog", appName)
		);

		// Harper's own defaultConfig.yaml ships `rootPath: null`, which is not a path.
		fs.writeFileSync(settings, "rootPath: null\n");
		const nulled = await withEnvs({ ROOTPATH: undefined }, () =>
			withHome(home, () => prepareRuntime())
		);
		assert.notEqual(
			nulled.paths.runtimeDir,
			path.join("null", "datadog", appName),
			"`rootPath: null` was taken for a directory name"
		);
	});
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Load with the module's own 60s start deadline shortened, so the real timer decides rather than the test. */
const withShortDeadline = (run) =>
	withPatchedSetTimeout(
		(realSetTimeout) =>
			(callback, ms, ...rest) =>
				realSetTimeout(callback, ms === 60_000 ? 20 : ms, ...rest),
		run
	);

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
