// @ts-check
import { styleText } from "node:util";

// One prefix for the build CLI, which speaks as the package rather than as the tool the reader is
// being told to run next. Nothing under runtime/ logs through this: the component uses Harper's log.
const PREFIX = "[datadog-agent]";

/** @type {Record<"info" | "warn" | "error" | "debug", (message: string) => void>} */
export const logger = {
	info: (/** @type {string} */ message) =>
		console.log(styleText("blue", PREFIX), message),
	warn: (message) =>
		console.warn(styleText("yellow", PREFIX), styleText("yellow", message)),
	error: (message) =>
		console.error(styleText("red", PREFIX), styleText("red", message)),
	debug: (message) => {
		if (process.env.DEBUG) {
			console.log(styleText("gray", PREFIX), styleText("gray", message));
		}
	},
};
