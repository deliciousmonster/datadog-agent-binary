/**
 * The dda installer's interpreter choice. pipx creates each venv with the Python it
 * was itself installed under, which is 3.10 on the ubuntu-22.04 runner while dda
 * requires 3.12, so `pipx install dda` there rejects every published version and
 * actions/setup-python does nothing about it. Twelve consecutive nightly builds died
 * on that before anything was compiled.
 *
 * Hermetic: the pin file and every command the installer runs are stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, withTempDir } from '../support/harness.js';

const { AgentBuilder } = await importDist('builder.js');

/** A builder whose tool probes and interpreter reads are fixed values. */
function builderWith({ pin, tools = ['pipx'], pythons = {} }) {
	const commands = [];
	const builder = new (class extends AgentBuilder {
		async readPythonVersionPin() {
			return pin;
		}
		async executeCommand(command) {
			commands.push(command);
			if (command === 'dda --version') {
				throw new Error('dda: command not found');
			}
			const probe = /^(uv|pipx) --version$/.exec(command);
			if (probe) {
				if (!tools.includes(probe[1])) throw new Error(`${probe[1]}: command not found`);
				return `${probe[1]} 1.0.0\n`;
			}
			const interpreter = /^(python3|python) -c /.exec(command);
			if (interpreter) {
				const found = pythons[interpreter[1]];
				if (!found) throw new Error(`${interpreter[1]}: command not found`);
				return `${found.version} ${found.executable}\n`;
			}
			return '';
		}
	})({ sourceDir: '/nonexistent' });
	return { builder, commands };
}

const installCommand = (commands) => commands.find((command) => command.includes('install dda'));

test('the interpreter satisfying the pin is handed to pipx, which cannot pick it itself', async () => {
	const { builder, commands } = builderWith({
		pin: '3.12\n',
		pythons: { python3: { version: '3.12', executable: '/opt/hostedtoolcache/Python/3.12.8/x64/bin/python3' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(
		installCommand(commands),
		'pipx install dda --python /opt/hostedtoolcache/Python/3.12.8/x64/bin/python3'
	);
});

test('an interpreter newer than the pin satisfies it', async () => {
	const { builder, commands } = builderWith({
		pin: '3.12\n',
		pythons: { python3: { version: '3.13', executable: '/usr/bin/python3.13' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(installCommand(commands), 'pipx install dda --python /usr/bin/python3.13');
});

test("a PATH interpreter below the pin is not passed, since pipx's own default may be newer", async () => {
	const { builder, commands } = builderWith({
		pin: '3.12\n',
		pythons: { python3: { version: '3.10', executable: '/usr/bin/python3' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(installCommand(commands), 'pipx install dda');
});

test('a source shipping no .python-version has no opinion to enforce', async () => {
	const { builder, commands } = builderWith({
		pin: undefined,
		pythons: { python3: { version: '3.12', executable: '/usr/bin/python3' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(installCommand(commands), 'pipx install dda');
	assert.ok(!commands.some((command) => command.includes('-c ')));
});

test('python3 absent falls through to python, which is the spelling Windows ships', async () => {
	const { builder, commands } = builderWith({
		pin: '3.12\n',
		pythons: { python: { version: '3.12', executable: 'C:\\hostedtoolcache\\Python\\3.12.8\\x64\\python.exe' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(
		installCommand(commands),
		'pipx install dda --python C:\\hostedtoolcache\\Python\\3.12.8\\x64\\python.exe'
	);
});

test('an interpreter path with a space in it is refused rather than split into two arguments', async () => {
	const { builder, commands } = builderWith({
		pin: '3.12\n',
		pythons: { python3: { version: '3.12', executable: 'C:\\Program Files\\Python312\\python.exe' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(installCommand(commands), 'pipx install dda');
});

test('uv is preferred and provisions its own interpreter, so it takes no flag', async () => {
	const { builder, commands } = builderWith({
		pin: '3.12\n',
		tools: ['uv', 'pipx'],
		pythons: { python3: { version: '3.10', executable: '/usr/bin/python3' } },
	});
	await builder.ensureDdaInstalled();
	assert.equal(installCommand(commands), 'uv tool install dda');
	assert.ok(!commands.some((command) => command.startsWith('pipx')));
});

test('neither installer present still refuses rather than leaving a broken user-site install', async () => {
	const { builder } = builderWith({ pin: '3.12\n', tools: [] });
	await assert.rejects(() => builder.ensureDdaInstalled(), /uv tool install dda/);
});

/** A builder over a real source tree, so the pin read is the real one. */
function builderOver(sourceDir) {
	return new (class extends AgentBuilder {
		async executeCommand() {
			return '';
		}
	})({ sourceDir });
}

test('a source tree with no .python-version leaves the interpreter to pipx', () =>
	withTempDir('py-pin-absent-', async (sourceDir) => {
		assert.equal(await builderOver(sourceDir).pipxPythonFlag(), '');
	}));

test('a .python-version that exists but cannot be read fails instead of reading as absent', () =>
	withTempDir('py-pin-unreadable-', (sourceDir) => {
		// See the .go-version case: a directory is the one non-ENOENT failure every host
		// produces the same way.
		fs.mkdirSync(path.join(sourceDir, '.python-version'));
		return assert.rejects(
			() => builderOver(sourceDir).pipxPythonFlag(),
			/Cannot read \.python-version/,
			'an unreadable pin must not hand pipx the interpreter choice it cannot make'
		);
	}));
