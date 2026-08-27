import * as path from 'node:path';
import { DatadogAgentDownloader } from './downloader.js';
import { createBuilder } from './builder.js';
import { logger } from './logger.js';
import { BuildConfig, BuildResult } from './types.js';
import { Platform } from './platform.js';

/** What a caller may vary per build. Anything else is derived from the platform. */
export interface BuildOptions {
	version?: string;
	outputDir?: string;
}

export class DatadogAgentBuilder {
	private downloader: DatadogAgentDownloader;

	constructor() {
		this.downloader = new DatadogAgentDownloader();
	}

	async buildForPlatform(platform: Platform, options: BuildOptions = {}): Promise<BuildResult> {
		// Both binaries come from this one ref: the core agent and trace-agent share an
		// IPC auth handshake and a config schema, so a mismatched pair fails at the
		// handshake with nothing in the error naming the cause. resolveVersion falls back
		// to the pin in .datadog-agent-version, never to upstream "latest", and proves the
		// tag exists before we clone.
		const version = await this.downloader.resolveVersion(options.version);
		const platformName = platform.getName();
		const outputDir = options.outputDir || './build';

		const platformBuildDir = path.join(process.cwd(), 'build', platformName);
		const sourceDir = path.join(platformBuildDir, 'src');

		logger.info(`Building Datadog Agent ${version} for ${platformName}`);

		await this.downloader.downloadSource({
			version,
			extractTo: sourceDir,
		});

		const config: BuildConfig = {
			platform,
			outputDir,
			sourceDir,
		};

		return createBuilder(config).build();
	}

	buildForCurrentPlatform(options: BuildOptions = {}): Promise<BuildResult> {
		return this.buildForPlatform(Platform.current(), options);
	}
}

// The named public API, instead of six export *. Everything else (the launcher,
// the logger, the AgentBuilder class, SUPPORTED_PLATFORMS) is reached through its
// own module by the scripts and shims that need it, and a wildcard here would
// silently promote every future internal helper to public surface.
export { BinaryManager } from './binary-manager.js';
export { DatadogAgentDownloader } from './downloader.js';
export { createBuilder } from './builder.js';
export { Platform } from './platform.js';
// Public because a component that spawns the trace-agent itself has to reach the same
// verdict this package's own launcher reaches, from the same evidence and in the same
// words. example/dd-supervisor.js is the caller that proved the second copy drifts.
export {
	DEFAULT_RECEIVER_PORT,
	RECEIVER_BIND_TIMEOUT_MS,
	RECEIVER_DISABLED,
	RECEIVER_DISABLED_WARNING,
	describeUnboundReceiver,
	receiverAdvertisesTraces,
	resolveReceiverPort,
	waitForReceiver,
} from './trace-receiver.js';
export type {
	AgentBinaryDescriptor,
	AgentBinaryKind,
	Architecture,
	BuildConfig,
	BuildResult,
	DownloadConfig,
	Logger,
	OS,
} from './types.js';
