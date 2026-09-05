// withBuiltBinaries writes stubs at build/<platform>/bin, the same paths `npm run build-agent` puts the
// real agents at, so what it does with what was already there decides whether running this suite destroys
// a developer's build. hideFiles alone is driven against a temp directory; the last test drives the real
// paths, with a real build renamed out of the way under a name no part of the fixture knows.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	acquireResolveBinaryLock,
	builtBinaryPaths,
	hideFiles,
	plantBuiltBinaries,
	stub,
	STAYS_UP,
	UNEXECUTABLE,
} from "../support/component.js";
import { withTempDir } from "../support/sandbox.js";

const HIDDEN = ".hidden-by-fixture";
const SAVED = ".saved-by-test";

/** Identity that survives a rename and not a rewrite, so a restored file is told from a recreated one. */
const identity = (file) => {
	const { ino, size, mode } = fs.statSync(file);
	return { ino, size, mode };
};

const writeExecutable = (file, body) => {
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
};

test("hideFiles gives back the same file, not a copy of it", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");
		writeExecutable(file, stub("exit 0"));
		const before = identity(file);

		const restore = hideFiles([file]);
		assert.ok(
			!fs.existsSync(file),
			"the path was not cleared, so a caller writing a stub would overwrite the original"
		);
		writeExecutable(file, stub(STAYS_UP));
		restore();

		assert.deepEqual(
			identity(file),
			before,
			"the file came back rewritten rather than renamed, which loses the mode and rewrites 139MB"
		);
	}));

test("hideFiles leaves a path that held nothing holding nothing", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");

		const restore = hideFiles([file]);
		writeExecutable(file, stub(STAYS_UP));
		restore();

		assert.ok(
			!fs.existsSync(file),
			"a stub was left behind at a path that started empty"
		);
	}));

test("NEGATIVE: a build stranded by an interrupted run comes back on the next hide-and-restore", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");
		// Exactly what a killed run leaves: renamed aside, never restored, the real path empty. Nothing is
		// hidden this time round, so the restore is the only thing that can put the build back.
		writeExecutable(`${file}${HIDDEN}`, stub("exit 0"));
		const stranded = identity(`${file}${HIDDEN}`);

		const restore = hideFiles([file]);
		restore();

		assert.deepEqual(
			identity(file),
			stranded,
			"the stranded build was not recovered to its real path"
		);
		assert.ok(
			!fs.existsSync(`${file}${HIDDEN}`),
			"the hidden copy was left behind to strand the next run too"
		);
	}));

test("NEGATIVE: a run killed holding its stub does not cost the build stashed beside it", () =>
	withTempDir("hide-files-", async (dir) => {
		// The sharp case: killed after the stub was written, so the real path holds the stub and the build
		// sits at the hidden copy. Hiding the stub over it is what silently destroys the build.
		const file = path.join(dir, "agent");
		writeExecutable(
			`${file}${HIDDEN}`,
			"#!/bin/sh\n# the real build\nexit 0\n"
		);
		const real = identity(`${file}${HIDDEN}`);
		writeExecutable(file, stub(STAYS_UP));

		const restore = hideFiles([file]);
		writeExecutable(file, stub(STAYS_UP));
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"the stub was hidden over the real build, which is now gone with nothing naming it"
		);
	}));

test("NEGATIVE: a run killed holding a broken stand-in costs no more than one holding a stub", () =>
	withTempDir("hide-files-", async (dir) => {
		// supervisor-start.test.js overwrites a planted stub to make a spawn fail, so the body left at the
		// real path is not one stub() produced. Unstamped it reads as a build made since, and the hide below
		// moves it over the real one.
		const file = path.join(dir, "agent");
		writeExecutable(
			`${file}${HIDDEN}`,
			"#!/bin/sh\n# the real build\nexit 0\n"
		);
		const real = identity(`${file}${HIDDEN}`);
		writeExecutable(file, UNEXECUTABLE);

		const restore = hideFiles([file]);
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"a stand-in the fixture wrote was hidden over the real build, which is now gone"
		);
	}));

test("NEGATIVE: hideFiles does not promote a leftover copy over a file that is already there", () =>
	withTempDir("hide-files-", async (dir) => {
		// The dangerous shape: something at the real path AND a leftover beside it. Preferring the leftover
		// would overwrite a real build with whatever an interrupted run happened to leave.
		const file = path.join(dir, "agent");
		writeExecutable(file, "#!/bin/sh\n# the real one\nexit 0\n");
		const real = identity(file);
		writeExecutable(`${file}${HIDDEN}`, "#!/bin/sh\n# a leftover\nexit 7\n");

		const restore = hideFiles([file]);
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"a leftover copy displaced the file that was actually there"
		);
	}));

/**
 * Everything the fixture reads at `files` renamed out of the two names it knows, and the put-back. A rename,
 * not a copy or a hardlink: a link shares the inode, so any in-place write at the real path reaches the
 * saved copy too, and a 139MB build costs nothing to move either way.
 */
function saveAside(files) {
	const owned = files.flatMap((file) => [file, `${file}${HIDDEN}`]);
	for (const file of owned) {
		if (fs.existsSync(file)) fs.renameSync(file, `${file}${SAVED}`);
	}
	return () =>
		owned.forEach((file) => {
			fs.rmSync(file, { force: true });
			if (fs.existsSync(`${file}${SAVED}`)) {
				fs.renameSync(`${file}${SAVED}`, file);
			}
		});
}

test("the built-binaries fixture puts back what it found at build/<platform>/bin", async () => {
	// The one test that can catch the fixture losing its hide-and-restore, so it runs on a checkout that has
	// a build as well as one that has not: saveAside takes the real agents out of reach first, and the
	// stand-ins planted in their place are what the stubs would destroy.
	const { binDir, files } = builtBinaryPaths();
	fs.mkdirSync(binDir, { recursive: true });
	// Held across the staging too, not just the fixture call: these are the paths resolveBinary reads, and
	// test/e2e/harper-component.test.js holds this same lock across a test asserting no trace-agent is here.
	const release = await acquireResolveBinaryLock();
	let restoreReal;
	try {
		restoreReal = saveAside(files);
		for (const file of files) writeExecutable(file, stub("exit 0"));
		const before = files.map(identity);

		const seen = await plantBuiltBinaries(
			async (stubs) => stubs.map((file) => fs.readFileSync(file, "utf8")),
			STAYS_UP
		);
		// Without this the fixture could have handed back what was already there rather than its own
		// stubs, and the survival asserted below would hold while proving nothing.
		for (const body of seen) {
			assert.equal(
				body,
				stub(STAYS_UP),
				"the fixture did not write its own stub"
			);
		}

		files.forEach((file, index) => {
			assert.ok(
				fs.existsSync(file),
				`${path.basename(file)} was deleted by the fixture instead of put back`
			);
			assert.deepEqual(
				identity(file),
				before[index],
				`${path.basename(file)} came back as a different file, so a real build would have been lost`
			);
		});
	} finally {
		restoreReal?.();
		release();
	}
});
