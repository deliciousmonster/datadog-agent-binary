// @ts-check
// The kit's `build/<target>` plus what compiling the agent needs under it. The kit owns root and bin, where
// four processes meet; the clone, its GOPATH symlink and the extraction scratch are this repo's alone.

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

/**
 * The tree at an already-resolved directory, for a caller holding the path and not the target. @param {string}
 * root @returns {BuildTree}
 */
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
