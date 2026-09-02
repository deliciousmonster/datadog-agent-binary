"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Restores the previous value rather than deleting, so a nested use cannot leak into a sibling test.
async function withEnv(name, value, run) {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

/** os.homedir() reads HOME on POSIX and USERPROFILE on Windows. */
const withHome = (home, run) =>
	withEnv("HOME", home, () => withEnv("USERPROFILE", home, run));

async function withTempDir(prefix, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

module.exports = { withEnv, withHome, withTempDir };
