// withBuiltBinaries writes stubs at build/<platform>/bin, the same paths `npm run build-agent` puts the
// real agents at, so what it does with what was already there decides whether running this suite destroys
// a developer's build. The hide-and-restore that protects them is driven here against a temp directory:
// staging an interrupted run over the real paths is the very hazard this file exists to keep out.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	builtBinaryPaths,
	hideFiles,
	withBuiltBinaries,
	STAYS_UP,
} from "../support/component.js";
import { withTempDir } from "../support/sandbox.js";

const HIDDEN = ".hidden-by-fixture";

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
		writeExecutable(file, "#!/bin/sh\nexit 0\n");
		const before = identity(file);

		const restore = hideFiles([file]);
		assert.ok(
			!fs.existsSync(file),
			"the path was not cleared, so a caller writing a stub would overwrite the original"
		);
		writeExecutable(file, STAYS_UP);
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
		writeExecutable(file, STAYS_UP);
		restore();

		assert.ok(
			!fs.existsSync(file),
			"a stub was left behind at a path that started empty"
		);
	}));

test("NEGATIVE: hideFiles recovers a build stranded by an interrupted run", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");
		// Exactly what a killed run leaves: renamed aside, never restored, the real path empty.
		writeExecutable(`${file}${HIDDEN}`, "#!/bin/sh\nexit 0\n");
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
		writeExecutable(file, STAYS_UP);

		const restore = hideFiles([file]);
		writeExecutable(file, STAYS_UP);
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"the stub was hidden over the real build, which is now gone with nothing naming it"
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

test("withBuiltBinaries puts back what it found at build/<platform>/bin", async (t) => {
	// Only ever runs against a directory it found empty, and only on files it planted there itself. A real
	// build is left strictly alone: exercising this fixture is what deletes binaries when it misbehaves, so
	// a version of this test that ran over one would destroy the developer's build to prove it should not.
	const { binDir, files } = builtBinaryPaths();
	fs.mkdirSync(binDir, { recursive: true });
	const occupied = files.filter((file) => fs.existsSync(file));
	if (occupied.length) {
		t.skip(
			`a real build is at ${binDir}; the hide-and-restore itself is covered against a temp dir above`
		);
		return;
	}
	const planted = files;
	for (const file of planted) writeExecutable(file, "#!/bin/sh\nexit 0\n");
	const before = files.map(identity);

	try {
		const seen = await withBuiltBinaries(
			async (stubs) => stubs.map((stub) => fs.readFileSync(stub, "utf8")),
			STAYS_UP
		);
		// Without this the fixture could have handed back what was already there rather than its own
		// stubs, and the survival asserted below would hold while proving nothing.
		for (const body of seen) {
			assert.equal(body, STAYS_UP, "the fixture did not write its own stub");
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
		for (const file of planted) fs.rmSync(file, { force: true });
	}
});
