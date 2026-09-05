#!/usr/bin/env node

import { Command } from "commander";
import { logger } from "./log.js";
import {
	buildAgents,
	currentTarget,
	fetchLatestVersion,
	targetNames,
} from "./index.js";

// One exit path: commands throw, and the failure is reported here rather than in each action.
const run =
	<T>(action: (options: T) => Promise<void>) =>
	async (options: T): Promise<void> => {
		try {
			await action(options);
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	};

const program = new Command()
	.name("datadog-agent-build")
	.description("Build Datadog Agent from source for multiple platforms");

program
	.command("build")
	.description("Build Datadog Agent for current platform")
	.option("--datadog-version <version>", "Datadog Agent version to build")
	.option("-d, --debug", "Enable debug logging")
	// No output option: scripts/create-platform-packages.js reads the built binaries back out of
	// build/<target>/bin, so a relocatable tree is a tree the packaging step cannot find.
	.action(
		run(async (options: { datadogVersion?: string; debug?: boolean }) => {
			if (options.debug) process.env.DEBUG = "1";
			const shipped = await buildAgents({
				target: currentTarget(),
				version: options.datadogVersion,
			});
			for (const path of shipped) logger.info(`Built ${path}`);
		})
	);

program
	.command("platforms")
	.description("List all supported platforms")
	.action(() => {
		logger.info("Supported platforms:");
		for (const name of targetNames()) logger.info(`  ${name}`);
	});

program
	.command("version")
	.description("Show latest Datadog Agent version")
	.action(
		run(async () => {
			logger.info(
				`Latest Datadog Agent version: ${await fetchLatestVersion()}`
			);
		})
	);

program.parse();
