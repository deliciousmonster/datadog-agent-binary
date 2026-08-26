#!/usr/bin/env node

import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import * as path from 'node:path';
import { DatadogAgentBuilder, BinaryManager, DatadogAgentDownloader } from './index.js';
import { errorMessage, logger, BUILD_FROM_SOURCE_HINT } from './logger.js';
import { Platform, getAllSupportedPlatforms } from './platform.js';

const NAME = 'datadog-agent-build';

const HELP = {
	'': `Usage: ${NAME} [options] [command]

Build Datadog Agent from source for multiple platforms

Options:
  -h, --help       display help for command

Commands:
  build [options]  Build Datadog Agent for current platform
  platforms        List all supported platforms
  version          Show the pinned and the latest Datadog Agent versions
  install          Install every Datadog Agent binary (core agent and
                   trace-agent) for the current platform`,
	'build': `Usage: ${NAME} build [options]

Build Datadog Agent for current platform

Options:
  --datadog-version <version>  Datadog Agent version to build
  -o, --output <dir>           Output directory (default: "./build")
  -d, --debug                  Enable debug logging
  -h, --help                   display help for command`,
	'platforms': `Usage: ${NAME} platforms

List all supported platforms

Options:
  -h, --help  display help for command`,
	'version': `Usage: ${NAME} version

Show the pinned and the latest Datadog Agent versions

Options:
  -h, --help  display help for command`,
	'install': `Usage: ${NAME} install

Install every Datadog Agent binary (core agent and trace-agent) for the current
platform

Options:
  -h, --help  display help for command`,
};

const HELP_ONLY = { help: { type: 'boolean', short: 'h' } } as const;

/**
 * `allowPositionals` is off everywhere on purpose: it is what makes
 * `datadog-agent-build install 7.79.2` exit non-zero instead of silently installing the
 * current platform, which is the behaviour that argument used to have.
 */
function parse<T extends ParseArgsOptionsConfig>(options: T) {
	return parseArgs({ args: process.argv.slice(3), options, allowPositionals: false });
}

async function build(): Promise<void> {
	const { values } = parse({
		'datadog-version': { type: 'string' },
		'output': { type: 'string', short: 'o', default: './build' },
		'debug': { type: 'boolean', short: 'd' },
		...HELP_ONLY,
	});

	if (values.help) {
		console.log(HELP.build);
		return;
	}

	if (values.debug) {
		process.env.DEBUG = '1';
	}

	const builder = new DatadogAgentBuilder();

	try {
		logger.info('Building for current platform...');
		const currentPlatform = Platform.current();
		const outputDir = path.join(values.output, currentPlatform.getName(), 'bin');
		const result = await builder.buildForCurrentPlatform({
			version: values['datadog-version'],
			outputDir,
		});

		logger.info(`\nBuild Summary:`);
		if (result.success) {
			// Report every binary. A summary that prints one path when two were built
			// reads as a successful single-binary build, which is how a missing
			// trace-agent went unnoticed through an entire release.
			for (const [kind, outputPath] of Object.entries(result.outputPaths ?? {})) {
				logger.info(`Successful (${kind}): ${outputPath}`);
			}
			process.exit(0);
		} else {
			logger.error(`Failed: ${result.error}`);
			process.exit(1);
		}
	} catch (error) {
		logger.error(`Build failed: ${errorMessage(error)}`);
		process.exit(1);
	}
}

function platforms(): void {
	const { values } = parse(HELP_ONLY);

	if (values.help) {
		console.log(HELP.platforms);
		return;
	}

	logger.info('Supported platforms:');
	for (const platform of getAllSupportedPlatforms()) {
		logger.info(`  ${platform}`);
	}
}

async function version(): Promise<void> {
	const { values } = parse(HELP_ONLY);

	if (values.help) {
		console.log(HELP.version);
		return;
	}

	const downloader = new DatadogAgentDownloader();

	// The pin is what `build` uses, so report it first and report it even when the
	// network lookup below fails.
	try {
		logger.info(`Pinned Datadog Agent version: ${await downloader.getPinnedVersion()}`);
	} catch (error) {
		logger.error(`Failed to read the pinned version: ${errorMessage(error)}`);
		process.exit(1);
	}

	try {
		logger.info(`Latest upstream Datadog Agent version: ${await downloader.getLatestVersion()}`);
	} catch (error) {
		logger.warn(`Failed to fetch the latest upstream version: ${errorMessage(error)}`);
	}
}

async function install(): Promise<void> {
	const { values } = parse(HELP_ONLY);

	if (values.help) {
		console.log(HELP.install);
		return;
	}

	try {
		const manager = new BinaryManager();

		// Every binary this platform ships, not just the core agent: resolving the core
		// agent alone is how a release went out with nothing bound to 127.0.0.1:8126.
		const binaries = Platform.current().getBinaries();
		for (const descriptor of binaries) {
			const binaryPath = await manager.ensureBinary(descriptor.kind);
			logger.info(`Datadog ${descriptor.kind} agent installed: ${binaryPath}`);
		}
		logger.info('Run with: datadog-agent <command> / datadog-trace-agent <command>');
	} catch (error) {
		logger.error(`Installation failed: ${errorMessage(error)}`);
		logger.info(BUILD_FROM_SOURCE_HINT);
		process.exit(1);
	}
}

const COMMANDS: Record<string, () => void | Promise<void>> = { build, platforms, version, install };

async function main(): Promise<void> {
	const command = process.argv[2];

	if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
		console.log(HELP['']);
		// No command is a usage error and exits 1; an explicit help request exits 0. Scripts
		// branch on that difference, so the two cannot collapse into one code.
		process.exit(command === undefined ? 1 : 0);
	}

	const run = COMMANDS[command];
	if (!run) {
		console.error(`error: unknown command '${command}'`);
		process.exit(1);
	}

	await run();
}

// parseArgs throws for an unknown option and, with allowPositionals off, for an excess
// argument. Both are usage errors: exit non-zero with the message, never a stack.
main().catch((error: unknown) => {
	if (error instanceof Error && String((error as NodeJS.ErrnoException).code ?? '').startsWith('ERR_PARSE_ARGS_')) {
		console.error(`error: ${error.message}`);
		process.exit(1);
	}
	throw error;
});
