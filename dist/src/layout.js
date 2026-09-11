import { join } from "node:path";
/** The tree at an already-resolved `build/<target>` directory, for a caller holding the path and not the target. */
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
export function buildTree(root, target) {
    return treeAt(join(root, "build", target.name));
}
//# sourceMappingURL=layout.js.map