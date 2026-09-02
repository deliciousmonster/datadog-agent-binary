"use strict";

// What upstream's 7.82.1 build assumes a host already has. tools/bazel exits 2 when CI is set and
// XDG_CACHE_HOME names no directory, which is why this passed on a laptop and died on a runner.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("./support/generator.js");
const { withEnv, withHome, withTempDir } = require("./support/sandbox.js");
const { findTarget } = require(path.join(REPO_ROOT, "dist", "targets.js"));
const { prepareHost } = require(path.join(REPO_ROOT, "dist", "build.js"));

const LINUX = findTarget("linux-x86_64");

test("under CI with no XDG_CACHE_HOME, the XDG default is created and exported", async () => {
	await withTempDir("ddab-xdg-default-", (home) =>
		withHome(home, () =>
			withEnv("CI", "true", () =>
				withEnv("XDG_CACHE_HOME", undefined, async () => {
					const expected = path.join(home, ".cache");
					const env = await prepareHost(LINUX, home);
					assert.equal(env.XDG_CACHE_HOME, expected);
					assert.ok(fs.statSync(expected).isDirectory());
				})
			)
		)
	);
});

test("an explicit XDG_CACHE_HOME wins and is created, so a cache action can point the build at it", async () => {
	await withTempDir("ddab-xdg-explicit-", (home) => {
		const requested = path.join(home, "workspace", ".cache");
		return withHome(home, () =>
			withEnv("CI", "true", () =>
				withEnv("XDG_CACHE_HOME", requested, async () => {
					const env = await prepareHost(LINUX, home);
					assert.equal(env.XDG_CACHE_HOME, requested);
					assert.ok(fs.statSync(requested).isDirectory());
					assert.ok(!fs.existsSync(path.join(home, ".cache")));
				})
			)
		);
	});
});

test("an empty XDG_CACHE_HOME is treated as unset, since the wrapper rejects it too", async () => {
	await withTempDir("ddab-xdg-empty-", (home) =>
		withHome(home, () =>
			withEnv("CI", "true", () =>
				withEnv("XDG_CACHE_HOME", "  ", async () => {
					const env = await prepareHost(LINUX, home);
					assert.equal(env.XDG_CACHE_HOME, path.join(home, ".cache"));
				})
			)
		)
	);
});

test("off CI nothing is created and no XDG_CACHE_HOME is exported", async () => {
	await withTempDir("ddab-xdg-local-", (home) => {
		const requested = path.join(home, "workspace", ".cache");
		return withHome(home, () =>
			withEnv("CI", undefined, () =>
				withEnv("XDG_CACHE_HOME", requested, async () => {
					const env = await prepareHost(LINUX, home);
					assert.ok(!("XDG_CACHE_HOME" in env));
					assert.ok(!fs.existsSync(requested));
					assert.ok(!fs.existsSync(path.join(home, ".cache")));
				})
			)
		);
	});
});
