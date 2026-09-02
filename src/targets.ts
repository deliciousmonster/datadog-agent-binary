export type OS = "linux" | "macos" | "windows";
export type Arch = "x86_64" | "arm64";

export interface Target {
	readonly os: OS;
	readonly arch: Arch;
	/** Package-name segment and build-directory name, e.g. `linux-x86_64`. */
	readonly name: string;
	readonly goos: string;
	readonly goarch: string;
	readonly exe: string;
	/** Shell command that must succeed before this OS can build. */
	readonly precondition?: string;
}

const SYSTEMS: Record<OS, Omit<Target, "os" | "arch" | "name" | "goarch">> = {
	linux: { goos: "linux", exe: "" },
	macos: { goos: "darwin", exe: "", precondition: "xcode-select -p" },
	windows: { goos: "windows", exe: ".exe" },
};

const GOARCH: Record<Arch, string> = { x86_64: "amd64", arm64: "arm64" };

const target = (os: OS, arch: Arch): Target => ({
	os,
	arch,
	name: `${os}-${arch}`,
	goarch: GOARCH[arch],
	...SYSTEMS[os],
});

export const TARGETS: readonly Target[] = [
	target("linux", "x86_64"),
	target("linux", "arm64"),
	target("macos", "x86_64"),
	target("macos", "arm64"),
	target("windows", "x86_64"),
];

export const targetNames = (): string[] => TARGETS.map((t) => t.name);

export function findTarget(name: string): Target {
	const found = TARGETS.find((t) => t.name === name);
	if (!found)
		throw new Error(
			`Unsupported platform: ${name}. Supported: ${targetNames().join(", ")}`
		);
	return found;
}

// process.arch reports x64/arm64; process.platform reports darwin/win32.
export function currentTarget(): Target {
	const os: OS =
		process.platform === "darwin"
			? "macos"
			: process.platform === "win32"
				? "windows"
				: "linux";
	const arch: Arch = process.arch === "arm64" ? "arm64" : "x86_64";
	return findTarget(`${os}-${arch}`);
}
