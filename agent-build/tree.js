// @ts-check
// One target's build tree, which is the kit's `build/<target>` plus what compiling Datadog's agent needs
// under it.
//
// The kit owns `root` and `bin` because four processes on separate runners meet at those two paths and the
// staging reads them. The other three are this repo's own scratch and nothing outside it has any business
// knowing them: the clone, the GOPATH the clone is symlinked into so the Go toolchain resolves the agent by
// import path, and a directory for the .deb an extraction unpacks.

import { join } from "node:path";

import { buildTree as kitTree } from "@deliciousmonster/harper-binary-kit/layout";

/**
 * @typedef {object} BuildTree
 * @property {string} root
 * @property {string} bin Where every binary lands, built or lifted, so the staging reads one directory.
 * @property {string} source The clone of Datadog's repository at the pinned tag.
 * @property {string} goPath GOPATH, with `src/github.com/DataDog/datadog-agent` linked at `source`.
 * @property {string} extract Scratch for the extraction: the downloaded .deb and its unpacked payload.
 */

/** The tree at an already-resolved directory, for a caller holding the path and not the target. @param {string} root @returns {BuildTree} */
export function treeAt(root) {
	return {
		root,
		bin: join(root, "bin"),
		source: join(root, "src"),
		goPath: join(root, "go"),
		extract: join(root, "extract"),
	};
}

/** @param {string} root @param {{ name: string }} target @returns {BuildTree} */
export const buildTree = (root, target) =>
	treeAt(kitTree(root, target.name).root);
