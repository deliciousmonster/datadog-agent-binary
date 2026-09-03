// Loading and driving resources.js the way Harper does. The module keeps per-thread start state and reads
// its ports once at load, so a suite that varies either needs its own instance rather than a shared import.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { REPO_ROOT, BINARIES, currentTarget } = require("./generator.js");

export { REPO_ROOT };

let instance = 0;

/** A fresh resources.js. The query string is what defeats the ES module cache. */
export function loadComponent() {
	const url = pathToFileURL(path.join(REPO_ROOT, "resources.js")).href;
	return import(`${url}?instance=${instance++}`);
}

/** A binary that exits at once, which is all a suite driving a recorded Harper ever runs. */
export const EXITS_AT_ONCE = "#!/bin/sh\nexit 0\n";

/** A binary that stays up, so a suite spawning for real has a live pid to find behind the lock. */
export const STAYS_UP = "#!/bin/sh\nexec sleep 15\n";

/**
 * Both agent binaries where resources.js looks for a dev checkout's build output, for the duration of
 * `run`. The installed platform package predates the trace-agent and answers every request with the core
 * agent, so without these nothing that needs a trace-agent path can be driven at all.
 */
export async function withBuiltBinaries(run, body = EXITS_AT_ONCE) {
	const target = currentTarget();
	const binDir = path.join(REPO_ROOT, "build", target.name, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const files = BINARIES.map((binary) =>
		path.join(binDir, `${binary.shipsAs}${target.exe}`)
	);
	for (const file of files) {
		fs.writeFileSync(file, body);
		fs.chmodSync(file, 0o755);
	}
	try {
		return await run(files);
	} finally {
		for (const file of files) fs.rmSync(file, { force: true });
	}
}

/**
 * Harper's process sidecar, recorded. `verify` runs against `state`, so a suite sets the state a real
 * Harper would report and reads back the verdict the component reached from it.
 */
export function recordingScope({ state = {} } = {}) {
	const starts = [];
	return {
		starts,
		processes: {
			async start(options) {
				starts.push(options);
				const processState = {
					started: true,
					adopted: false,
					pid: 4321,
					exited: false,
					...state,
				};
				const verdict = await options.verify(processState);
				return {
					...processState,
					verified: verdict.ok,
					verifyDetail: verdict.detail,
				};
			},
		},
	};
}

/** The start options recorded for one agent, by the spawn name Harper locks on. */
export const startFor = (scope, name) =>
	scope.starts.find((options) => options.name === name);
