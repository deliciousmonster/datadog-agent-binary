// CI runs `prettier --check .` and the pre-commit hook runs prettier over a glob. When the two disagree, the
// hook passes and CI fails, and the only place that shows is a red run on a push that looked clean locally.
// test/soak/soak.mjs committed that way on 2026-09-15: the glob read *.{ts,js,json} and .mjs was not in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const manifest = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

/** The extensions one lint-staged glob covers, from its brace list. `*.{ts,js}` gives ["ts", "js"]. */
export function extensionsIn(glob) {
	const braced = glob.match(/^\*\.\{([^}]+)\}$/);
	if (braced?.[1]) return braced[1].split(",").map((part) => part.trim());
	const plain = glob.match(/^\*\.([A-Za-z0-9]+)$/);
	return plain?.[1] ? [plain[1]] : [];
}

test("the brace list is read, not guessed at", () => {
	assert.deepEqual(extensionsIn("*.{ts,js,mjs,json}"), [
		"ts",
		"js",
		"mjs",
		"json",
	]);
	assert.deepEqual(extensionsIn("*.md"), ["md"]);
	assert.deepEqual(
		extensionsIn("**/*.weird"),
		[],
		"a shape this cannot read must widen nothing"
	);
});

test("the pre-commit glob covers every extension CI's own prettier run checks", () => {
	const covered = new Set(
		Object.keys(manifest["lint-staged"] ?? {}).flatMap(extensionsIn)
	);
	assert.ok(covered.size > 0, "no lint-staged globs; this check is blind");

	// Tracked files, since an untracked one is never staged and never reaches CI either.
	const tracked = execFileSync("git", ["ls-files"], {
		cwd: new URL("../../", import.meta.url),
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);

	// Prettier's own supported extensions, narrowed to what this repo actually carries. A file type prettier
	// ignores cannot fail CI, and one it formats can.
	const FORMATTED = new Set([
		"ts",
		"js",
		"mjs",
		"cjs",
		"jsx",
		"tsx",
		"json",
		"jsonc",
		"md",
		"yml",
		"yaml",
		"css",
		"html",
	]);
	const uncovered = new Set();
	for (const file of tracked) {
		const ext = extname(file).slice(1);
		if (FORMATTED.has(ext) && !covered.has(ext)) uncovered.add(ext);
	}
	assert.deepEqual(
		[...uncovered].sort(),
		[],
		`these extensions are tracked and formatted by \`prettier --check .\` but the pre-commit glob skips them, so a badly formatted one commits clean and fails CI: ${[...uncovered].join(", ")}`
	);
});
