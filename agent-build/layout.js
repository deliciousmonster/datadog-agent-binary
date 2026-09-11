// @ts-check
import { join } from "node:path";
/**
 * One target's build tree: the clone, the GOPATH it is linked into, and the binaries built out of it.
 *
 * @typedef {object} BuildTree
 * @property {string} root
 * @property {string} source
 * @property {string} goPath
 * @property {string} bin
 * @property {string} extract Scratch for the extraction step: the downloaded .deb, its unpacked payload,
 *   a throwaway gpg home.
 */

/** The tree at an already-resolved `build/<target>` directory, for a caller holding the path and not the target. @param {string} root @returns {BuildTree} */
export function treeAt(root) {
	return {
		root,
		source: join(root, "src"),
		goPath: join(root, "go"),
		bin: join(root, "bin"),
		extract: join(root, "extract"),
	};
}

// The build CLI and scripts/create-platform-packages.js run as separate processes, on separate CI
// runners, and meet only at this path. It is a convention, so it gets exactly one definition.
/** @param {string} root @param {import("./toolchain.js").Target} target @returns {BuildTree} */
export function buildTree(root, target) {
	return treeAt(join(root, "build", target.name));
}
