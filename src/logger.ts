import { styleText } from "node:util";
import { Logger } from "./types.js";

export class ConsoleLogger implements Logger {
	private prefix: string;

	constructor(prefix = "[datadog-agent-build]") {
		this.prefix = prefix;
	}

	info(message: string): void {
		console.log(styleText("blue", this.prefix), message);
	}

	warn(message: string): void {
		console.warn(
			styleText("yellow", this.prefix),
			styleText("yellow", message)
		);
	}

	error(message: string): void {
		console.error(styleText("red", this.prefix), styleText("red", message));
	}

	debug(message: string): void {
		if (process.env.DEBUG) {
			console.log(styleText("gray", this.prefix), styleText("gray", message));
		}
	}
}

export const logger = new ConsoleLogger();

/** Caught values are `unknown`; this keeps the narrowing in one place. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
