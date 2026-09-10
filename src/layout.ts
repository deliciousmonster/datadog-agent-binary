import { join } from "node:path";
import { Target } from "./targets.js";

/** One target's build tree: the clone, the GOPATH it is linked into, and the binaries built out of it. */
export interface BuildTree {
	readonly root: string;
	readonly source: string;
	readonly goPath: string;
	readonly bin: string;
	/** Scratch for the extraction step: the downloaded .deb, its unpacked payload, a throwaway gpg home. */
	readonly extract: string;
}

/** The tree at an already-resolved `build/<target>` directory, for a caller holding the path and not the target. */
export function treeAt(root: string): BuildTree {
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
export function buildTree(root: string, target: Target): BuildTree {
	return treeAt(join(root, "build", target.name));
}
