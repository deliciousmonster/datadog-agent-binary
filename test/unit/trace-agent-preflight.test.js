/**
 * `preflightTraceAgentConfig()`, the check that runs before the trace-agent is
 * spawned. Both of the trace-agent's pre-bind failures are illegible from its own
 * output: a missing datadog.yaml kills it instantly with "unable to load Datadog
 * config file", and an unwritable config directory hangs it for 30 seconds before
 * it dies writing its auth_token.
 *
 * The load-bearing distinction here is EXPLICIT vs INFERRED. The trace-agent does
 * not read the core agent's /etc/datadog-agent/datadog.yaml; its default is
 * `filepath.Join(setup.InstallPath, "etc/datadog.yaml")`, and `osinit()` rewrites
 * InstallPath from the location of the running executable, which for a binary npm
 * unpacked into node_modules is a directory with no datadog.yaml in it. Failing
 * closed on that guess would turn a working launch into a refused one, so an
 * inferred path may only warn. A path the caller stated is different: there the
 * check knows what the agent will read.
 *
 * Hermetic: temp dirs and a zero-byte stub, no agent binary, no network.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { preflightTraceAgentConfig, LaunchPreflightError } = require(
	path.join(REPO_ROOT, "dist", "agent-launcher.js")
);

const isWindows = process.platform === "win32";

function withTempDir(fn) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ddpf-")));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A binary laid out the way a platform package lays one out: <root>/bin/trace-agent.
 * The inferred config path is <root>/etc/datadog.yaml.
 */
function stubBinary(root) {
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	const binaryPath = path.join(root, "bin", "trace-agent");
	fs.writeFileSync(binaryPath, "");
	return binaryPath;
}

function captureWarnings(fn) {
	const warnings = [];
	const realWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		fn();
	} finally {
		console.warn = realWarn;
	}
	return warnings;
}

test("an explicitly named config file that does not exist is fatal", () => {
	withTempDir((dir) => {
		assert.throws(
			() =>
				preflightTraceAgentConfig(["-c", path.join(dir, "absent.yaml"), "run"]),
			LaunchPreflightError
		);
	});
});

test("an explicitly named config file that exists passes", () => {
	withTempDir((dir) => {
		const configPath = path.join(dir, "datadog.yaml");
		// Zero bytes on purpose: the agent's requirement is presence, not content.
		fs.writeFileSync(configPath, "");
		assert.doesNotThrow(() =>
			preflightTraceAgentConfig(["-c", configPath, "run"])
		);
	});
});

test("every spelling of the config flag is recognised, including the = form", () => {
	withTempDir((dir) => {
		const configPath = path.join(dir, "datadog.yaml");
		fs.writeFileSync(configPath, "");
		for (const argv of [
			["-c", configPath],
			["--config", configPath],
			["-config", configPath],
			["--cfgpath", configPath],
			["-cfgpath", configPath],
			[`-c=${configPath}`],
			[`--config=${configPath}`],
		]) {
			assert.doesNotThrow(
				() => preflightTraceAgentConfig(argv),
				`${argv[0]} should have been recognised as the config flag`
			);
		}
	});
});

test("a config flag pointing at a directory resolves to <dir>/datadog.yaml", () => {
	withTempDir((dir) => {
		// The file is inside the directory, so this only passes if the directory
		// value was expanded rather than stat'd as a file.
		fs.writeFileSync(path.join(dir, "datadog.yaml"), "");
		assert.doesNotThrow(() => preflightTraceAgentConfig(["-c", dir, "run"]));
	});
});

test("an inferred config path that does not exist warns instead of refusing", () => {
	withTempDir((dir) => {
		const binaryPath = stubBinary(dir);
		// No config flag, so the path is derived from the binary's own location.
		// Blocking a launch on that guess is the regression this asserts against.
		const warnings = captureWarnings(() =>
			assert.doesNotThrow(() => preflightTraceAgentConfig(["run"], binaryPath))
		);
		assert.equal(warnings.length, 1, "the guess must be reported, not silent");
		assert.match(
			warnings[0],
			/No config flag was passed/,
			"the warning must say the path was inferred"
		);
		assert.ok(
			warnings[0].includes(path.join(dir, "etc", "datadog.yaml")),
			`the warning must name the derived path; got: ${warnings[0]}`
		);
	});
});

test("the inferred path is derived from the binary, not from /etc/datadog-agent", () => {
	withTempDir((dir) => {
		const binaryPath = stubBinary(dir);
		// <root>/etc/datadog.yaml is what upstream's InstallPath resolves to once
		// osinit() rewrites it from the executable location. A launcher still
		// checking the core agent's /etc/datadog-agent/datadog.yaml would warn here.
		fs.mkdirSync(path.join(dir, "etc"), { recursive: true });
		fs.writeFileSync(path.join(dir, "etc", "datadog.yaml"), "");
		const warnings = captureWarnings(() =>
			assert.doesNotThrow(() => preflightTraceAgentConfig(["run"], binaryPath))
		);
		assert.deepEqual(warnings, []);
	});
});

test("an unwritable config directory is fatal", (t) => {
	if (isWindows) {
		t.skip("POSIX mode bits do not gate directory writes on Windows");
		return;
	}
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("root ignores the mode bits this test relies on");
		return;
	}
	withTempDir((dir) => {
		const locked = path.join(dir, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "datadog.yaml"), "");
		fs.chmodSync(locked, 0o500);
		try {
			assert.throws(
				() =>
					preflightTraceAgentConfig(["-c", path.join(locked, "datadog.yaml")]),
				/not writable/,
				"the agent writes auth_token beside the config; without write access it " +
					"hangs 30s and dies"
			);
		} finally {
			// Restore before the temp dir is removed, or rmSync cannot descend.
			fs.chmodSync(locked, 0o700);
		}
	});
});
