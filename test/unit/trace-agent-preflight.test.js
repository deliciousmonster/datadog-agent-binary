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
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
// pathToFileURL because import() of a bare absolute path is rejected on Windows.
const { preflightTraceAgentConfig, LaunchPreflightError } = await import(
	pathToFileURL(path.join(REPO_ROOT, 'dist', 'agent-launcher.js')).href
);

const isWindows = process.platform === 'win32';

function withTempDir(fn) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ddpf-')));
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
	fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
	const binaryPath = path.join(root, 'bin', 'trace-agent');
	fs.writeFileSync(binaryPath, '');
	return binaryPath;
}

function captureWarnings(fn) {
	const warnings = [];
	const realWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(' '));
	try {
		fn();
	} finally {
		console.warn = realWarn;
	}
	return warnings;
}

test('an explicitly named config file that does not exist is fatal', () => {
	withTempDir((dir) => {
		assert.throws(() => preflightTraceAgentConfig(['-c', path.join(dir, 'absent.yaml'), 'run']), LaunchPreflightError);
	});
});

test('an explicitly named config file that exists passes', () => {
	withTempDir((dir) => {
		const configPath = path.join(dir, 'datadog.yaml');
		// Zero bytes on purpose: the agent's requirement is presence, not content.
		fs.writeFileSync(configPath, '');
		assert.doesNotThrow(() => preflightTraceAgentConfig(['-c', configPath, 'run']));
	});
});

test('every spelling of the config flag makes its missing file fatal, including the = form', () => {
	// Asserted through the throw, not through doesNotThrow against a file that
	// exists: a spelling that stops being recognised degrades the stated path to
	// an inferred guess, and an inferred guess only warns, so the doesNotThrow
	// form stayed green with the recognition deleted.
	withTempDir((dir) => {
		const absent = path.join(dir, 'absent.yaml');
		for (const argv of [
			['-c', absent],
			['--config', absent],
			['-config', absent],
			['--cfgpath', absent],
			['-cfgpath', absent],
			[`-c=${absent}`],
			[`--config=${absent}`],
		]) {
			assert.throws(
				() => preflightTraceAgentConfig(argv),
				(error) =>
					error instanceof LaunchPreflightError &&
					// The error must name the stated path, proving the flag's VALUE was
					// parsed rather than the flag merely detected.
					error.message.includes(absent),
				`${argv[0]} was not treated as an explicitly stated config path`
			);
		}
	});
});

test('a config flag pointing at a directory is checked at <dir>/datadog.yaml', () => {
	withTempDir((dir) => {
		// The directory exists and its datadog.yaml does not. A preflight that
		// stats the directory value as the config file sees it exist and passes,
		// so only the resolved <dir>/datadog.yaml can make this throw.
		assert.throws(
			() => preflightTraceAgentConfig(['-c', dir, 'run']),
			(error) => error instanceof LaunchPreflightError && error.message.includes(path.join(dir, 'datadog.yaml')),
			'the directory value must be resolved to <dir>/datadog.yaml'
		);
	});
});

test('an inferred config path that does not exist warns instead of refusing', () => {
	withTempDir((dir) => {
		const binaryPath = stubBinary(dir);
		// No config flag, so the path is derived from the binary's own location.
		// Blocking a launch on that guess is the regression this asserts against.
		const warnings = captureWarnings(() => assert.doesNotThrow(() => preflightTraceAgentConfig(['run'], binaryPath)));
		assert.equal(warnings.length, 1, 'the guess must be reported, not silent');
		assert.match(warnings[0], /No config flag was passed/, 'the warning must say the path was inferred');
		assert.ok(
			warnings[0].includes(path.join(dir, 'etc', 'datadog.yaml')),
			`the warning must name the derived path; got: ${warnings[0]}`
		);
	});
});

test('the inferred path is derived from the binary, not from /etc/datadog-agent', () => {
	withTempDir((dir) => {
		const binaryPath = stubBinary(dir);
		// <root>/etc/datadog.yaml is what upstream's InstallPath resolves to once
		// osinit() rewrites it from the executable location. A launcher still
		// checking the core agent's /etc/datadog-agent/datadog.yaml would warn here.
		fs.mkdirSync(path.join(dir, 'etc'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'etc', 'datadog.yaml'), '');
		const warnings = captureWarnings(() => assert.doesNotThrow(() => preflightTraceAgentConfig(['run'], binaryPath)));
		assert.deepEqual(warnings, []);
	});
});

test('an unwritable config directory is fatal', (t) => {
	if (isWindows) {
		t.skip('POSIX mode bits do not gate directory writes on Windows');
		return;
	}
	if (typeof process.getuid === 'function' && process.getuid() === 0) {
		t.skip('root ignores the mode bits this test relies on');
		return;
	}
	withTempDir((dir) => {
		const locked = path.join(dir, 'locked');
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, 'datadog.yaml'), '');
		fs.chmodSync(locked, 0o500);
		try {
			assert.throws(
				() => preflightTraceAgentConfig(['-c', path.join(locked, 'datadog.yaml')]),
				/not writable/,
				'the agent writes auth_token beside the config; without write access it ' + 'hangs 30s and dies'
			);
		} finally {
			// Restore before the temp dir is removed, or rmSync cannot descend.
			fs.chmodSync(locked, 0o700);
		}
	});
});
