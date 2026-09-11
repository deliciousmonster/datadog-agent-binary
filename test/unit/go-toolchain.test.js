// Which Go compiles the agent, which is not a number this repo gets to choose.
//
// A toolchain newer than the pin is the dangerous case, and it is the one `go.mod` does not object to.
// Measured on 2026-09-10: Go 1.27.0 against a source pinning 1.26.5 produced a macOS system-probe that
// panicked before main with `strcase.UnicodeVersion "15.0.0" != unicode.Version "17.0.0"`, because 1.27
// moved the Unicode tables and `charlievieth/strcase` asserts its own match the runtime's. That binary
// packages, passes the publish gate's symbol check, and never runs. Nothing downstream can catch it, so
// the pin has to be read from the release rather than configured beside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { goPin, goToolchain } from "../../agent-build/compile.js";

const withSource = async (contents, run) => {
	const dir = mkdtempSync(join(tmpdir(), "ddab-gopin-"));
	try {
		if (contents !== null) writeFileSync(join(dir, ".go-version"), contents);
		return await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("the toolchain comes from the release's own .go-version", async () => {
	await withSource("1.26.5\n", async (dir) => {
		assert.equal(await goPin(dir), "1.26.5");
		assert.deepEqual(goToolchain("1.26.5"), { GOTOOLCHAIN: "go1.26.5" });
	});
});

// GOTOOLCHAIN takes a toolchain NAME. An unprefixed version is rejected rather than ignored, which is the
// better of the two failures and still a build that does not start.
test("the toolchain is named, not versioned", () => {
	assert.equal(goToolchain("1.26.5").GOTOOLCHAIN, "go1.26.5");
	assert.doesNotMatch(goToolchain("1.26.5").GOTOOLCHAIN, /^\d/);
});

// A two-part pin is what some tags carry, and refusing it would pin nothing on those.
test("a two-part pin is honoured, not refused", () => {
	assert.deepEqual(goToolchain("1.26"), { GOTOOLCHAIN: "go1.26" });
});

// A tag shipping no .go-version has no opinion, and inventing one would pin the build to a version
// upstream never asked for. Same contract as .python-version.
test("a release with no pin leaves the toolchain to go.mod", async () => {
	await withSource(null, async (dir) => {
		assert.equal(await goPin(dir), "");
		assert.deepEqual(goToolchain(""), {});
	});
});

// The failure that matters is a silent one: setting GOTOOLCHAIN to something Go cannot parse would make
// every build fail with a message about the variable rather than about the file it came from.
test("NEGATIVE: a .go-version that is not a version sets no toolchain at all", async () => {
	for (const junk of ["latest", "go1.26.5", "1.26.5-rc1", "", "  ", "auto"]) {
		assert.deepEqual(
			goToolchain(junk),
			{},
			`"${junk}" was turned into a GOTOOLCHAIN value`
		);
	}
});

// Whitespace is what a file written by a human carries, and an untrimmed pin fails the version test above
// and so silently pins nothing.
test("NEGATIVE: a pin with surrounding whitespace still pins", async () => {
	await withSource("  1.26.5  \n\n", async (dir) => {
		const pin = await goPin(dir);
		assert.equal(pin, "1.26.5");
		assert.deepEqual(goToolchain(pin), { GOTOOLCHAIN: "go1.26.5" });
	});
});

// The drift this replaced. The workflow's GO_VERSION is the toolchain that runs the build tasks, and it
// must not be read as the one that compiles the agent: it said 1.23 against a source asking 1.26.5 and
// passed anyway, because go.mod makes Go fetch what it needs. A number nothing enforces is decorative.
test("the workflow's GO_VERSION does not decide what compiles the agent", async () => {
	const { readFile } = await import("node:fs/promises");
	const workflow = await readFile(
		new URL("../../.github/workflows/build-release.yml", import.meta.url),
		"utf8"
	);
	const declared = /GO_VERSION:\s*"([^"]+)"/.exec(workflow)?.[1];
	assert.ok(declared, "GO_VERSION is gone; this check is now blind");
	// Nothing passes it to the agent build. If it ever reaches GOTOOLCHAIN, the pin has a second source.
	assert.doesNotMatch(
		workflow,
		/GOTOOLCHAIN[^\n]*GO_VERSION/,
		"GO_VERSION now sets GOTOOLCHAIN, so the pin has two sources again"
	);
});
