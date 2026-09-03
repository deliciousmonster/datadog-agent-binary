#!/usr/bin/env node

import { Command } from "commander";
import { join } from "node:path";
import {
	buildAgents,
	currentTarget,
	fetchLatestVersion,
	logger,
	targetNames,
} from "./index.js";

// One exit path: commands throw, and the failure is reported here rather than in each action.
const run =
	<T>(action: (options: T) => Promise<void>, hint?: string) =>
	async (options: T): Promise<void> => {
		try {
			await action(options);
		} catch (error) {
			logger.error(error instanceof Error ? error.message : String(error));
			if (hint) logger.info(hint);
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
	.option("-o, --output <dir>", "Output directory", "./build")
	.option("-d, --debug", "Enable debug logging")
	.action(
		run(
			async (options: {
				datadogVersion?: string;
				output: string;
				debug?: boolean;
			}) => {
				if (options.debug) process.env.DEBUG = "1";
				const target = currentTarget();
				const shipped = await buildAgents({
					target,
					version: options.datadogVersion,
					outputDir: join(options.output, target.name, "bin"),
				});
				for (const path of shipped) logger.info(`Built ${path}`);
			}
		)
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
