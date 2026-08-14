import { BuildConfig } from '../types.js';
import { BaseBuilder } from './base.js';
import { LinuxBuilder } from './linux.js';
import { WindowsBuilder } from './windows.js';
import { MacOSBuilder } from './macos.js';

export function createBuilder(config: BuildConfig): BaseBuilder {
	const osName = config.platform.getOS();
	switch (osName) {
		case 'linux':
			return new LinuxBuilder(config);
		case 'windows':
			return new WindowsBuilder(config);
		case 'macos':
			return new MacOSBuilder(config);
		default:
			throw new Error(`Unsupported OS: ${osName}`);
	}
}

export { BaseBuilder, LinuxBuilder, WindowsBuilder, MacOSBuilder };
