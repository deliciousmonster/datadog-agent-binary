// withBuiltBinaries writes stubs at build/<platform>/bin, the same paths `npm run build-agent` puts the
// real agents at. What it does with what was already there decides whether running this suite destroys a
// real build, so that is asserted here rather than left to whoever notices their binaries are gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	acquireResolveBinaryLock,
	withBuiltBinaries,
	REPO_ROOT,
	STAYS_UP,
} from "../support/component.js";
import { BINARIES, currentTarget } from "../support/generator.js";

const target = currentTarget();
const binDir = path.join(REPO_ROOT, "build", target.name, "bin");
const files = BINARIES.map((binary) =>
	path.join(binDir, `${binary.shipsAs}${target.exe}`)
);

/** Distinct per binary, so a restore that puts the wrong file back is caught rather than averaged out. */
const realBytes = (file) =>
	`#!/bin/sh\n# real ${path.basename(file)}\nexit 7\n`;

/**
 * `run` with the lock held, so no concurrent withBuiltBinaries can have these paths renamed aside at the
 * moment this reads them. Planting and asserting are what need it; withBuiltBinaries takes it itself.
 */
async function underLock(run) {
	const release = await acquireResolveBinaryLock();
	try {
		return run();
	} finally {
		release();
	}
}

/**
 * A developer's real build stashed under a suffix of this file's own, then put back byte-for-byte and
 * mode-for-mode. Renamed rather than copied: reading 139MB back through writeFileSync drops the exec bit.
 */
function stashRealBuild() {
	const stashed = files.map((file) => `${file}.fixture-test-stash`);
	fs.mkdirSync(binDir, { recursive: true });
	const present = files.map((file, index) => {
		if (!fs.existsSync(file)) return false;
		fs.renameSync(file, stashed[index]);
		return true;
	});
	return () =>
		files.forEach((file, index) => {
			fs.rmSync(file, { force: true });
			if (present[index]) fs.renameSync(stashed[index], file);
		});
}

/** A planted stand-in for a real build: distinct bytes, and the exec bit a spawned agent needs. */
function plantFakeBuild() {
	for (const file of files) {
		fs.writeFileSync(file, realBytes(file));
		fs.chmodSync(file, 0o755);
	}
}

test("a real build already at build/<platform>/bin survives the stub fixture that writes over it", async () => {
	const unstash = await underLock(() => {
		const undo = stashRealBuild();
		plantFakeBuild();
		return undo;
	});

	try {
		const seen = await withBuiltBinaries(
			async (stubs) => stubs.map((stub) => fs.readFileSync(stub, "utf8")),
			STAYS_UP
		);
		// Without this the fixture could have been handing back the planted files rather than its own
		// stubs, and the restore asserted below would pass while proving nothing.
		for (const body of seen) {
			assert.equal(body, STAYS_UP, "the fixture did not write its own stub");
		}

		await underLock(() => {
			for (const file of files) {
				assert.ok(
					fs.existsSync(file),
					`${path.basename(file)} was deleted by the fixture instead of put back`
				);
				assert.equal(
					fs.readFileSync(file, "utf8"),
					realBytes(file),
					`${path.basename(file)} came back as different bytes`
				);
				assert.ok(
					fs.statSync(file).mode & 0o111,
					`${path.basename(file)} came back without its exec bit, so nothing can spawn it`
				);
			}
		});
	} finally {
		await underLock(unstash);
	}
});

test("NEGATIVE: a fixture killed mid-run leaves the real binary recoverable, not stranded", async () => {
	const unstash = await underLock(() => stashRealBuild());

	try {
		// Exactly what a suite timeout leaves behind: renamed aside, never restored, the real path empty.
		await underLock(() => {
			for (const file of files) {
				fs.writeFileSync(`${file}.hidden-by-fixture`, realBytes(file));
				fs.rmSync(file, { force: true });
			}
		});

		await withBuiltBinaries(async () => {}, STAYS_UP);

		await underLock(() => {
			for (const file of files) {
				assert.equal(
					fs.readFileSync(file, "utf8"),
					realBytes(file),
					`${path.basename(file)} was not recovered from an interrupted prior run`
				);
				assert.ok(
					!fs.existsSync(`${file}.hidden-by-fixture`),
					`${path.basename(file)} left its hidden copy behind`
				);
			}
		});
	} finally {
		await underLock(() => {
			for (const file of files) {
				fs.rmSync(`${file}.hidden-by-fixture`, { force: true });
			}
			unstash();
		});
	}
});
