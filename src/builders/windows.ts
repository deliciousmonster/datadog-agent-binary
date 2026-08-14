import { BuildResult } from '../types.js';
import { BaseBuilder } from './base.js';

export class WindowsBuilder extends BaseBuilder {
	async build(): Promise<BuildResult> {
		return this.runBuild('Windows');
	}

	protected getOSEnvironmentVariables(): Record<string, string> {
		return {
			GOOS: 'windows',
		};
	}
}
