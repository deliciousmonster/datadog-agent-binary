// The oracle scripts/verify-package.js's table has never had. test/e2e/publish-gate.test.js writes both
// sides of every fixture it checks, so it proves the gate's branches and cannot say whether the values
// those branches read discriminate a real build. That is the gap a forbidden value present in every
// correctly-built core agent shipped through. Runs where the binaries are (`npm run test:binaries`).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, withRealBinaries } from "../support/component.js";

// The gate's own reader, not a copy of it: a parser that drifted from the one verify-package.js runs
// would let this pass while the release still refuses.
// A URL, not a path: import() refuses a bare `D:\...` on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const { BINARIES, recordedBuildTags } = await import(
	pathToFileURL(path.join(REPO_ROOT, "dist", "src", "binaries.js")).href
);

const binaryFor = (files, shipsAs) =>
	fs.readFileSync(
		files.find((file) => path.basename(file).startsWith(shipsAs))
	);

test("every requiredSymbol the gate demands is in the binary mandatoryArgs produces", async () => {
	await withRealBinaries((files) => {
		for (const binary of BINARIES) {
			assert.ok(
				binaryFor(files, binary.shipsAs).includes(
					Buffer.from(binary.requiredSymbol, "latin1")
				),
				`${binary.shipsAs} was built exactly as mandatoryArgs specifies and does not carry "${binary.requiredSymbol}", so the publish gate refuses the build it exists to approve`
			);
		}
	});
});

test("no forbiddenBuildTag the gate refuses is in the tag set the build records", async () => {
	await withRealBinaries((files) => {
		for (const binary of BINARIES.filter((entry) => entry.forbiddenBuildTag)) {
			const tags = recordedBuildTags(binaryFor(files, binary.shipsAs));
			assert.notEqual(
				tags,
				null,
				`${binary.shipsAs} carries no Go build-tag record at all, so the gate refuses every build of it`
			);
			assert.equal(
				tags.includes(binary.forbiddenBuildTag),
				false,
				`${binary.shipsAs} was built with --build-exclude and still records the "${binary.forbiddenBuildTag}" tag, so either the exclusion does not work or the gate refuses the build it exists to approve`
			);
		}
	});
});
