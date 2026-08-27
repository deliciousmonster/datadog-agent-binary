/**
 * The two halves of not building an embedded rtloader.
 *
 * `--build-exclude=systemd,python` reads like it covers this and does not: it strips a Go
 * build tag, while `tasks/agent.py` gates the embedded-rtloader install on a separate
 * `exclude_rtloader` parameter. Under the default `enable_bazel=True` that install
 * extracted an LLVM toolchain the Linux code path never invokes, and the linux-x86_64 leg
 * died with `No space left on device` in bazel analysis, on a runner with 14 GB of disk,
 * before a Go file compiled.
 *
 * Skipping it moves the cost: `get_build_flags` then raises "unable to locate embedded
 * path", because `get_embedded_path` looks for a `dev` directory that the install used to
 * create as a side effect. An empty one satisfies it, and `trace-agent.build` needs it too
 * with no flag of its own to point elsewhere.
 *
 * Hermetic: the source tree is a temp directory and every command is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importDist, withEnv, withTempDir } from '../support/harness.js';

const { AgentBuilder } = await importDist('builder.js');
const { Platform, SUPPORTED_PLATFORMS } = await importDist('platform.js');

/** Both flags upstream reads by name; neither is implied by the build excludes. */
const RTLOADER_FLAGS = ['--exclude-rtloader', '--no-enable-bazel'];

/**
 * A builder over a real (empty) source tree whose commands are recorded rather than run,
 * each with whether `dev/` already existed at the moment it was issued. Both command
 * paths are stubbed: the invoke tasks stream, and an unstubbed `streamCommand` would
 * spawn a real dda.
 */
function recordingBuilder(sourceDir) {
	const issued = [];
	const dev = path.join(sourceDir, 'dev');
	const record = (command) => issued.push({ command, devExisted: fs.existsSync(dev) });
	const builder = new (class extends AgentBuilder {
		async ensureGoVersion() {}
		async ensureCacheDirectory() {}
		async ensureDdaInstalled() {}
		async executeCommand(command) {
			record(command);
			return '';
		}
		async streamCommand(command) {
			record(command);
		}
	})({
		platform: new Platform('linux', 'x86_64'),
		sourceDir,
		outputDir: path.join(sourceDir, 'out'),
	});
	return { builder, issued, dev };
}

const invocations = (issued) => issued.filter((entry) => entry.command.includes(' inv '));

test('the core agent skips the rtloader install and its bazel path', () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const args = platform.getBinary('core').buildArgs.split(' ');
		for (const flag of RTLOADER_FLAGS) {
			assert.ok(
				args.includes(flag),
				`${platform.getName()}: core buildArgs is "${platform.getBinary('core').buildArgs}" and needs ` +
					`${flag}. --build-exclude only strips a Go build tag; tasks/agent.py gates the embedded ` +
					`rtloader install on exclude_rtloader, and enable_bazel defaults to true.`
			);
		}
	}
});

test('neither rtloader flag reaches the trace-agent, whose task defines neither', () => {
	for (const platform of SUPPORTED_PLATFORMS) {
		const args = platform.getBinary('trace').buildArgs;
		for (const flag of RTLOADER_FLAGS) {
			assert.ok(
				!args.includes(flag),
				`${platform.getName()}: trace buildArgs is "${args}". tasks/trace_agent.py::build() takes ` +
					`neither exclude_rtloader nor enable_bazel, so invoke rejects ${flag} as an unknown flag.`
			);
		}
	}
});

test('buildCommon creates an empty dev/ under the source directory', async () => {
	await withTempDir('embedded-path-', async (sourceDir) => {
		const { builder, dev } = recordingBuilder(sourceDir);

		await builder.buildCommon();

		assert.ok(fs.statSync(dev).isDirectory());
		// Empty is the point: get_embedded_path only calls os.path.exists, and
		// get_rtloader_paths over an empty tree bakes in no RPATH and no CGO_LDFLAGS -L.
		assert.deepEqual(fs.readdirSync(dev), []);
	});
});

test('dev/ exists before any dda inv command is issued, not merely by the end', async () => {
	await withTempDir('embedded-path-order-', async (sourceDir) => {
		const { builder, issued } = recordingBuilder(sourceDir);

		await builder.buildCommon();

		const ran = invocations(issued);
		assert.ok(ran.length > 0, 'no dda inv command was issued, so the ordering was never exercised');
		assert.deepEqual(
			ran.filter((entry) => !entry.devExisted).map((entry) => entry.command),
			[],
			'every dda inv task calls get_build_flags, which raises "unable to locate embedded path" ' +
				'when dev/ is missing. A dev/ created after the loop is too late.'
		);
	});
});

test('an already-present dev/ and its contents survive', async () => {
	await withTempDir('embedded-path-existing-', async (sourceDir) => {
		const { builder, dev } = recordingBuilder(sourceDir);
		fs.mkdirSync(path.join(dev, 'lib'), { recursive: true });

		await builder.buildCommon();

		assert.deepEqual(fs.readdirSync(dev), ['lib']);
	});
});

test('BUILD_ARGS env overrides still win over the descriptor defaults', async () => {
	await withTempDir('build-args-override-', (sourceDir) =>
		withEnv('DD_AGENT_BUILD_ARGS', '--build-exclude=python', () =>
			withEnv('DD_TRACE_AGENT_BUILD_ARGS', '--race', async () => {
				const { builder, issued } = recordingBuilder(sourceDir);

				await builder.buildCommon();

				const commands = invocations(issued).map((entry) => entry.command);
				assert.ok(
					commands.includes('dda --no-interactive inv agent.build --build-exclude=python'),
					`core override was not used: ${JSON.stringify(commands)}`
				);
				assert.ok(
					commands.includes('dda --no-interactive inv trace-agent.build --race'),
					`trace override was not used: ${JSON.stringify(commands)}`
				);
			})
		)
	);
});

test('a blank override falls back to the descriptor rather than dropping the flags', async () => {
	await withTempDir('build-args-blank-', (sourceDir) =>
		withEnv('DD_AGENT_BUILD_ARGS', '   ', async () => {
			const { builder } = recordingBuilder(sourceDir);
			const core = new Platform('linux', 'x86_64').getBinary('core');

			assert.equal(builder.getBuildArgs(core), core.buildArgs);
		})
	);
});
