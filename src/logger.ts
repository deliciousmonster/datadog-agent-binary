import { styleText } from "node:util";
export interface Logger {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
	debug: (message: string) => void;
}

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
