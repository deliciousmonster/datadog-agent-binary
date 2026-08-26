/**
 * `streamCommand()`, the path the two invoke build tasks take. It replaced a six-line
 * rolling window drawn with `\x1b[1A\x1b[2K` and no isTTY check, which on a runner wrote
 * cursor escapes into a log that has no cursor, re-emitted every line up to six times,
 * and erased one line more than it had printed, so the window walked upward into the
 * build's own header.
 *
 * Hermetic: `inherit` cannot be observed from inside this process, so the builder runs in
 * a child whose stdio is piped and the assertions read what that child emitted. No dda
 * and no toolchain; the streamed command is `node`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, withTempDir } from '../support/harness.js';

const DIST_INDEX = pathToFileURL(path.join(REPO_ROOT, 'dist', 'index.js')).href;

const HARNESS = `import { createBuilder, Platform } from ${JSON.stringify(DIST_INDEX)};
const builder = createBuilder({ platform: Platform.current(), sourceDir: process.cwd(), outputDir: process.cwd() });
try {
	const resolved = await builder.streamCommand(process.argv[2]);
	process.stdout.write('RESOLVED ' + resolved + '\\n');
} catch (error) {
	process.stdout.write('REJECTED ' + error.message + '\\n');
}
`;

/**
 * Run `command` through streamCommand in a child, from a source tree containing a script
 * that emits `lines` on stdout and one marker on stderr before exiting `exitCode`.
 */
function stream(command, { lines = [], exitCode = 0 } = {}) {
	return withTempDir('builder-stream-', (sourceDir) => {
		fs.writeFileSync(path.join(sourceDir, 'harness.mjs'), HARNESS);
		fs.writeFileSync(
			path.join(sourceDir, 'emit.js'),
			`process.stdout.write(${JSON.stringify(lines.map((line) => line + '\n').join(''))});\n` +
				`process.stderr.write('marker-on-stderr\\n');\n` +
				`process.exitCode = ${exitCode};\n`
		);

		// DEBUG would add the builder's own coloured log lines to the output under test.
		const { DEBUG: _ignored, ...env } = process.env;
		const child = spawnSync(process.execPath, ['harness.mjs', command], {
			cwd: sourceDir,
			encoding: 'utf8',
			env,
		});
		assert.equal(child.status, 0, `the harness itself failed: ${child.stderr}`);
		return child;
	});
}

const LINES = ['alpha', 'bravo', 'charlie', 'delta'];
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test('the streamed output reaches the log once per line, in order', async () => {
	const child = await stream('node emit.js', { lines: LINES });

	for (const line of LINES) {
		// Once, not six times: the rolling window reprinted its whole contents on every
		// input line, so a 40-minute build re-emitted most of itself.
		assert.equal(occurrences(child.stdout, line), 1, `${line} appeared ${occurrences(child.stdout, line)} times`);
	}
	assert.deepEqual(
		child.stdout
			.split('\n')
			.filter((line) => LINES.includes(line))
			.slice(0, LINES.length),
		LINES
	);
});

test('nothing writes a cursor escape, so a non-interactive log stays legible', async () => {
	const child = await stream('node emit.js', { lines: LINES });

	assert.ok(!child.stdout.includes('\x1b['), `stdout carries an escape sequence: ${JSON.stringify(child.stdout)}`);
	assert.ok(!child.stderr.includes('\x1b['), `stderr carries an escape sequence: ${JSON.stringify(child.stderr)}`);
});

test('stderr stays on stderr rather than being folded into stdout with a prefix', async () => {
	const child = await stream('node emit.js', { lines: LINES });

	assert.match(child.stderr, /marker-on-stderr/);
	assert.ok(!child.stdout.includes('marker-on-stderr'));
});

test('a streamed command resolves nothing, so no caller can parse output it never captured', async () => {
	const child = await stream('node emit.js', { lines: LINES });

	assert.match(child.stdout, /^RESOLVED undefined$/m);
});

test('a non-zero exit rejects, naming the code and the command', async () => {
	const child = await stream('node emit.js', { lines: LINES, exitCode: 3 });

	assert.match(child.stdout, /^REJECTED Command failed with exit code 3: node emit\.js$/m);
});

test('a command that will not start rejects rather than hanging', async () => {
	const child = await stream('datadog-agent-binary-no-such-command');

	assert.match(child.stdout, /^REJECTED Could not run datadog-agent-binary-no-such-command: /m);
});
