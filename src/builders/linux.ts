import { BuildResult } from '../types.js';
import { BaseBuilder } from './base.js';

export class LinuxBuilder extends BaseBuilder {
	async build(): Promise<BuildResult> {
		return this.runBuild('Linux');
	}

	protected getOSEnvironmentVariables(): Record<string, string> {
		return {
			GOOS: 'linux',
		};
	}
}
