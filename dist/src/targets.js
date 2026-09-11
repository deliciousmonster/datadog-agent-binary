const SYSTEMS = {
    linux: { goos: "linux", npmOs: "linux", exe: "" },
    macos: {
        goos: "darwin",
        npmOs: "darwin",
        exe: "",
        precondition: "xcode-select -p",
    },
    // 7.82.1 splices `-Wl,--pdb=` into extldflags for Windows unless DD_GO_PDB=0, and CGO_ENABLED=1
    // sends it to the host's ld. Nothing here ships a PDB, so the flag can only cost a link failure.
    windows: {
        goos: "windows",
        npmOs: "win32",
        exe: ".exe",
        env: { DD_GO_PDB: "0" },
    },
};
const ARCHES = {
    x86_64: { goarch: "amd64", npmCpu: "x64" },
    arm64: { goarch: "arm64", npmCpu: "arm64" },
};
const target = (os, arch) => ({
    os,
    arch,
    name: `${os}-${arch}`,
    ...ARCHES[arch],
    ...SYSTEMS[os],
});
// Must match build-release.yml's matrix exactly. A target listed here but never built publishes an
// optionalDependency that npm skips in silence, which is how macos-x86_64 shipped uninstallable.
export const TARGETS = [
    target("linux", "x86_64"),
    target("linux", "arm64"),
    target("macos", "arm64"),
    target("windows", "x86_64"),
];
export const targetNames = () => TARGETS.map((t) => t.name);
export function findTarget(name) {
    const found = TARGETS.find((t) => t.name === name);
    if (!found)
        throw new Error(`Unsupported platform: ${name}. Supported: ${targetNames().join(", ")}`);
    return found;
}
// process.arch reports x64/arm64; process.platform reports darwin/win32.
export function currentTarget() {
    const os = process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
            ? "windows"
            : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    return findTarget(`${os}-${arch}`);
}
//# sourceMappingURL=targets.js.map