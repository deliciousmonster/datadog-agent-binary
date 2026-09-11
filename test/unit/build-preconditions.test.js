import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// What upstream's 7.82.1 build assumes a host already has. tools/bazel exits 2 under CI without an
// XDG_CACHE_HOME, and .bazelrc plus tools/bazel.bat make two Windows assumptions a runner breaks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("../support/generator.js");
const { withEnv, withHome, withTempDir } = require("../support/sandbox.js");
const { findTarget } = require(
	path.join(REPO_ROOT, "agent-build", "toolchain.js")
);
const {
	environment,
	prepareHost,
	resolveWindowsShell,
	windowsShellCandidates,
	writeBazelShellOverride,
} = require(path.join(REPO_ROOT, "agent-build", "compile.js"));

const LINUX = findTarget("linux-x86_64");
const WINDOWS = findTarget("windows-x86_64");

const bashAt = (dir) => {
	const file = path.join(dir, "bash.exe");
	fs.writeFileSync(file, "");
	return file;
};

/** A Windows host with MSYS2 where the image really puts it, named through upstream's own variable. */
const onWindowsHost = (dir, run) =>
	withEnv("CI", undefined, () =>
		withHome(dir, () => withEnv("BAZEL_SH", bashAt(dir), run))
	);

/**
 * A throwaway HOME on a runner whose CI is `ci`, with XDG_CACHE_HOME set to `xdgCacheHome(home)`.
 * `run` is handed both, since two of these assert against the cache path they asked for.
 */
/**
 * A throwaway HOME on a runner whose CI is `ci`, with XDG_CACHE_HOME set to `xdgCacheHome(home)`.
 *
 * @param {{ prefix: string, ci?: string, xdgCacheHome?: (home: string) => string | undefined }} options
 * @param {(home: string, requested: string | undefined) => any} run
 */
const onCacheHost = ({ prefix, ci, xdgCacheHome = () => undefined }, run) =>
	withTempDir(prefix, (home) => {
		const requested = xdgCacheHome(home);
		return withHome(home, () =>
			withEnv("CI", ci, () =>
				withEnv("XDG_CACHE_HOME", requested, () => run(home, requested))
			)
		);
	});

test("under CI with no XDG_CACHE_HOME, the XDG default is created and exported", async () => {
	await onCacheHost(
		{ prefix: "ddab-xdg-default-", ci: "true" },
		async (home) => {
			const expected = path.join(home, ".cache");
			const env = await prepareHost(LINUX, home);
			assert.equal(env.XDG_CACHE_HOME, expected);
			assert.ok(fs.statSync(expected).isDirectory());
		}
	);
});

test("an explicit XDG_CACHE_HOME wins and is created, so a cache action can point the build at it", async () => {
	await onCacheHost(
		{
			prefix: "ddab-xdg-explicit-",
			ci: "true",
			xdgCacheHome: (home) => path.join(home, "workspace", ".cache"),
		},
		async (home, requested) => {
			const env = await prepareHost(LINUX, home);
			assert.equal(env.XDG_CACHE_HOME, requested);
			assert.ok(fs.statSync(requested).isDirectory());
			assert.ok(!fs.existsSync(path.join(home, ".cache")));
		}
	);
});

test("an empty XDG_CACHE_HOME is treated as unset, since the wrapper rejects it too", async () => {
	await onCacheHost(
		{ prefix: "ddab-xdg-empty-", ci: "true", xdgCacheHome: () => "  " },
		async (home) => {
			const env = await prepareHost(LINUX, home);
			assert.equal(env.XDG_CACHE_HOME, path.join(home, ".cache"));
		}
	);
});

test("off CI nothing is created and no XDG_CACHE_HOME is exported", async () => {
	await onCacheHost(
		{
			prefix: "ddab-xdg-local-",
			ci: undefined,
			xdgCacheHome: (home) => path.join(home, "workspace", ".cache"),
		},
		async (home, requested) => {
			const env = await prepareHost(LINUX, home);
			assert.ok(!("XDG_CACHE_HOME" in env));
			assert.ok(!fs.existsSync(requested));
			assert.ok(!fs.existsSync(path.join(home, ".cache")));
		}
	);
});

// The fixture is a literal Windows path, not mkdtemp's: a host POSIX path has no backslash to
// convert, which is how a broken respelling passes on macOS and fails on Windows.
test("a Windows target writes both bazel shell overrides, forward-slashed, into user.bazelrc", async () => {
	await withTempDir("ddab-win-shell-", async (dir) => {
		await writeBazelShellOverride(dir, "C:\\msys64\\usr\\bin\\bash.exe");
		const written = fs.readFileSync(path.join(dir, "user.bazelrc"), "utf8");
		assert.ok(!written.includes("\\"), written);
		assert.deepEqual(
			written.split("\n").filter((line) => line.startsWith("common:")),
			[
				"common:windows --repo_env=BAZEL_SH=C:/msys64/usr/bin/bash.exe",
				"common:windows --shell_executable=C:/msys64/usr/bin/bash.exe",
			]
		);
	});
});

test("the resolver takes the first candidate that exists, not the first it is handed", async () => {
	await withTempDir("ddab-win-resolve-", async (dir) => {
		const shell = bashAt(dir);
		assert.equal(
			await resolveWindowsShell(["C:\\absent\\usr\\bin\\bash.exe", shell]),
			shell
		);
	});
});

test("no MSYS2 bash anywhere fails loudly instead of writing a path that is wrong differently", async () => {
	await withTempDir("ddab-win-nobash-", async (dir) => {
		// Windows-shaped and absent on every host, so the diagnostic is checked in the spelling a
		// real Windows run would produce; the respelling applies to the rc file, not to this.
		const missing = "C:\\nowhere\\usr\\bin\\bash.exe";
		await assert.rejects(
			() => resolveWindowsShell([missing]),
			(/** @type {Error} */ error) => {
				assert.ok(error.message.includes(missing), error.message);
				assert.match(error.message, /No MSYS2 bash found.+BAZEL_SH/s);
				return true;
			}
		);
		assert.ok(!fs.existsSync(path.join(dir, "user.bazelrc")));
	});
});

test("the default candidates lead with the path the GitHub image actually uses", async () => {
	await withEnv("SystemDrive", "C:", () =>
		withEnv("BAZEL_SH", undefined, async () => {
			assert.deepEqual(windowsShellCandidates(), [
				"C:/msys64/usr/bin/bash.exe",
				"C:/tools/msys64/usr/bin/bash.exe",
			]);
		})
	);
});

test("BAZEL_SH is tried before either default, since upstream already owns that name", async () => {
	await withEnv("SystemDrive", "C:", () =>
		withEnv("BAZEL_SH", "D:/msys64/usr/bin/bash.exe", async () => {
			assert.equal(windowsShellCandidates()[0], "D:/msys64/usr/bin/bash.exe");
		})
	);
});

test("a Windows target points TEMP and TMP at the profile volume, which is where 8.3 is on", async () => {
	await withTempDir("ddab-win-temp-", (dir) =>
		onWindowsHost(dir, async () => {
			const env = await prepareHost(WINDOWS, dir);
			const expected = path.join(dir, "AppData", "Local", "Temp");
			assert.equal(env.TEMP, expected);
			assert.equal(env.TMP, expected);
			assert.ok(fs.statSync(expected).isDirectory());
		})
	);
});

test("the Windows shell override is resolved and written as part of preparing the host", async () => {
	await withTempDir("ddab-win-prepare-", (dir) =>
		onWindowsHost(dir, async () => {
			await prepareHost(WINDOWS, dir);
			const written = fs.readFileSync(path.join(dir, "user.bazelrc"), "utf8");
			const shell = path.join(dir, "bash.exe").replace(/\\/g, "/");
			assert.ok(written.includes(`--shell_executable=${shell}`), written);
		})
	);
});

test("a non-Windows target writes no override file and exports no TEMP", async () => {
	await withTempDir("ddab-win-noop-", (dir) =>
		onWindowsHost(dir, async () => {
			const env = await prepareHost(LINUX, dir);
			assert.ok(!("TEMP" in env));
			assert.ok(!("TMP" in env));
			assert.ok(!fs.existsSync(path.join(dir, "user.bazelrc")));
			assert.ok(!fs.existsSync(path.join(dir, "AppData")));
		})
	);
});

test("a Windows target turns off the PDB linker flag, which nothing here ships", async () => {
	await withEnv("DD_GO_PDB", undefined, async () => {
		assert.equal(environment(WINDOWS).DD_GO_PDB, "0");
		assert.ok(!("DD_GO_PDB" in environment(LINUX)));
	});
});
