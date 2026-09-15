// A consumer installs this component by extracting the tarball and running `npm install` in that directory,
// which is what Harper does when it deploys one. npm runs `prepare` for the package being installed in place,
// and `prepare` was `husky`: a devDependency, absent from the install, so every such install ended at
// `sh: husky: not found` with exit 127. CI never saw it, because CI installs from a git checkout where husky
// is present.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

/** The lifecycle scripts npm runs when installing this package in place, with devDependencies omitted. */
const ON_CONSUMER_INSTALL = ["preinstall", "install", "postinstall", "prepare"];

/** The first command word of a script: what the shell tries to execute, and so what has to exist. */
export const firstCommand = (script) =>
	script.trim().split(/[\s;&|]+/)[0] ?? "";

/** Whether `script` carries on when its command is missing. `|| true` is not portable; cmd.exe has no true. */
export const survivesMissingCommand = (script) =>
	/\|\|\s*exit\s+0\b/.test(script);

test("the command word is read, not the whole script", () => {
	assert.equal(firstCommand("husky || exit 0"), "husky");
	assert.equal(firstCommand("  node scripts/x.js  "), "node");
	assert.equal(firstCommand("a && b"), "a");
});

test("only `|| exit 0` counts as tolerating a missing command", () => {
	assert.equal(survivesMissingCommand("husky || exit 0"), true);
	assert.equal(survivesMissingCommand("husky"), false);
	assert.equal(
		survivesMissingCommand("husky || true"),
		false,
		"cmd.exe has no `true`, so this still fails the Windows leg"
	);
});

test("no install-time script depends on a devDependency being there", () => {
	const devBins = new Set(Object.keys(manifest.devDependencies ?? {}));
	const broken = [];
	for (const name of ON_CONSUMER_INSTALL) {
		const script = manifest.scripts?.[name];
		if (!script) continue;
		const command = firstCommand(script);
		// A bare name resolves through node_modules/.bin, so a devDependency's bin is simply absent for a
		// consumer. An absolute or relative path, or `node`, is not this failure.
		const fromDevDep = devBins.has(command);
		if (fromDevDep && !survivesMissingCommand(script)) {
			broken.push(`${name}: \`${script}\` runs ${command}, a devDependency`);
		}
	}
	assert.deepEqual(
		broken,
		[],
		`these run on a consumer's \`npm install\` in the package directory and fail when devDependencies are omitted:\n${broken.join("\n")}`
	);
});
