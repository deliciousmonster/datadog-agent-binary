import { styleText } from "node:util";

// One prefix for both entry points. The build CLI and the runtime shim both speak as the package,
// not as the tool the reader is being told to run next.
const PREFIX = "[datadog-agent]";

export const logger = {
	info: (message: string): void =>
		console.log(styleText("blue", PREFIX), message),
	warn: (message: string): void =>
		console.warn(styleText("yellow", PREFIX), styleText("yellow", message)),
	error: (message: string): void =>
		console.error(styleText("red", PREFIX), styleText("red", message)),
	debug: (message: string): void => {
		if (process.env.DEBUG) {
			console.log(styleText("gray", PREFIX), styleText("gray", message));
		}
	},
};
