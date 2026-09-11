// The oracle the publish gate's table has never had.
//
// The kit's own suite writes both sides of every fixture it checks, so it proves the gate's branches and
// cannot say whether the values those branches read discriminate a real build. A requiredSymbol absent from
// every correctly-built binary would refuse every release; a forbiddenBuildTag present in every one of them
// would too. Only a real binary answers that, so this runs where they are (`npm run test:binaries`).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, withRealBinaries } from "../support/component.js";

// The gate's own reader, not a copy of it: a parser that drifted from the one verify-package.js runs
// would let this pass while the release still refuses.
// A URL, not a path: import() refuses a bare `D:\...` on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const { binariesFor, recordedBuildTags } = await import(
	pathToFileURL(path.join(REPO_ROOT, "agent-build", "binaries.js")).href
);
const { currentTarget } = await import(
	pathToFileURL(path.join(REPO_ROOT, "agent-build", "toolchain.js")).href
);

const binaryFor = (files, shipsAs) =>
	fs.readFileSync(
		files.find((file) => path.basename(file).startsWith(shipsAs))
	);

test("every requiredSymbol the gate demands is in the binary mandatoryArgs produces", async () => {
	await withRealBinaries((files) => {
		// binariesFor, not BINARIES: macOS builds no security-agent, so asking for one here reads a path
		// that is undefined and fails with a TypeError about the argument rather than about the binary.
		for (const binary of binariesFor(currentTarget())) {
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
		for (const binary of binariesFor(currentTarget()).filter(
			(entry) => entry.forbiddenBuildTag
		)) {
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
