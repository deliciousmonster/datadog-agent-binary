#!/usr/bin/env node

import { Command } from "commander";
import * as path from "path";
import {
	DatadogAgentBuilder,
	BinaryManager,
	DatadogAgentDownloader,
} from "./index.js";
import { logger } from "./logger.js";
import { Platform, getAllSupportedPlatforms } from "./platform.js";

const program = new Command();

program
	.name("datadog-agent-build")
	.description("Build Datadog Agent from source for multiple platforms");

program
	.command("build")
	.description("Build Datadog Agent for current platform")
	.option("--datadog-version <version>", "Datadog Agent version to build")
	.option("-o, --output <dir>", "Output directory", "./build")
	.option("--build-args <args>", "Additional build arguments")
	.option("-d, --debug", "Enable debug logging")
	.action(async (options) => {
		if (options.debug) {
			process.env.DEBUG = "1";
		}

		const builder = new DatadogAgentBuilder();

		try {
			logger.info("Building for current platform...");
			const currentPlatform = Platform.current();
			const outputDir = path.join(
				options.output,
				currentPlatform.getName(),
				"bin"
			);
			const result = await builder.buildForCurrentPlatform({
				version: options.datadogVersion,
				outputDir,
				buildArgs: options.buildArgs?.split(" "),
			});

			logger.info(`\nBuild Summary:`);
			if (result.success) {
				// Report every binary. A summary that prints one path when two were built
				// reads as a successful single-binary build, which is how a missing
				// trace-agent went unnoticed through an entire release.
				for (const [kind, outputPath] of Object.entries(
					result.outputPaths ?? {}
				)) {
					logger.info(`✅ Successful (${kind}): ${outputPath}`);
				}
				process.exit(0);
			} else {
				logger.error(`❌ Failed: ${result.error}`);
				process.exit(1);
			}
		} catch (error: any) {
			logger.error(`Build failed: ${error.message}`);
			process.exit(1);
		}
	});

program
	.command("platforms")
	.description("List all supported platforms")
	.action(() => {
		const platforms = getAllSupportedPlatforms();

		logger.info("Supported platforms:");
		for (const platform of platforms) {
			logger.info(`  ${platform}`);
		}
	});

program
	.command("version")
	.description("Show the pinned and the latest Datadog Agent versions")
	.action(async () => {
		const downloader = new DatadogAgentDownloader();

		// The pin is what `build` uses, so report it first and report it even when the
		// network lookup below fails.
		try {
			logger.info(
				`Pinned Datadog Agent version: ${await downloader.getPinnedVersion()}`
			);
		} catch (error: any) {
			logger.error(`Failed to read the pinned version: ${error.message}`);
			process.exit(1);
		}

		try {
			logger.info(
				`Latest upstream Datadog Agent version: ${await downloader.getLatestVersion()}`
			);
		} catch (error: any) {
			logger.warn(
				`Failed to fetch the latest upstream version: ${error.message}`
			);
		}
	});

program
	.command("install")
	.description(
		"Install every Datadog Agent binary (core agent and trace-agent) for the current platform"
	)
	.option("-v, --version <version>", "Specific version to install")
	.action(async (options) => {
		try {
			const manager = new BinaryManager();

			// Every binary this platform ships, not just the core agent. ensureBinary()
			// takes the kind first and the version second; commander types its options as
			// `any`, so passing them in the wrong order compiles.
			const binaries = Platform.current().getBinaries();
			for (const descriptor of binaries) {
				const binaryPath = await manager.ensureBinary(
					descriptor.kind,
					options.version
				);
				logger.info(
					`✅ Datadog ${descriptor.kind} agent installed: ${binaryPath}`
				);
			}
			logger.info(
				"Run with: datadog-agent <command> / datadog-trace-agent <command>"
			);
		} catch (error: any) {
			logger.error(`Installation failed: ${error.message}`);
			logger.info("You can build from source using: datadog-agent-build build");
			process.exit(1);
		}
	});

program.parse();
