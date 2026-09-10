// The Datadog release this package lifts binaries from, and the chain that proves what was lifted.
//
// Three of the four binaries need no build. Measured on 2026-09-10 against
// `datadog-agent_7.82.1-1_arm64.deb`: only the core `agent` links `libdatadog-agent-rtloader`, which is why
// it is built here with Python excluded. `trace-agent`, `system-probe` and `security-agent` link neither
// rtloader nor libpython, and each one runs relocated to a bare path in a container that never built it,
// reporting `7.82.1`. The release also carries 26 precompiled eBPF objects, which is the part that cannot
// sensibly be reproduced: they have to match the kernels an operator runs, and reproducing them needs a
// kernel-header tree per target. Datadog already solved that and ships the result.
//
// The chain, in the order `verifyRelease` walks it:
//   1. `Release` is signed by Datadog's APT key; `Release.gpg` is the detached signature.
//   2. `Release` carries the SHA256 of the per-architecture `Packages` index.
//   3. `Packages` carries the SHA256 of the .deb itself.
//   4. The .deb's own SHA256 is pinned below, so a rebuild is refused rather than silently following the
//      repository if upstream ever republishes this version.
// Verified end to end on 2026-09-10: GOODSIG from `Datadog, Inc. APT key (2023-04-20)`, and both Packages
// indexes hashing to what the signed Release names.

import type { OS } from "./targets.js";

/** Fingerprint of the key that must have signed the Release file. A different signer fails the build. */
export const DATADOG_APT_FINGERPRINT =
	"5F1E256061D813B125E156E8E6266D4AC0962C7D";

export const DATADOG_APT_KEY_URL =
	"https://keys.datadoghq.com/DATADOG_APT_KEY_CURRENT.public";

export const DATADOG_APT_BASE = "https://apt.datadoghq.com";

/** The suite the pinned packages live in, and the component under it. */
export const DATADOG_APT_SUITE = "stable";
export const DATADOG_APT_COMPONENT = "7";

/**
 * One artefact per target that ships an extracted binary.
 *
 * `sha256` and `size` were read out of the signed `Packages` index on 2026-09-10 rather than computed from
 * a download, so the pin and the repository agreed before either was written down. Bumping the agent
 * version means replacing both, and `verifyRelease` is what refuses a mismatch.
 */
export interface ReleaseArtifact {
	/** Path under the apt pool, joined to DATADOG_APT_BASE. */
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
	/** Debian architecture, which names the Packages index that hashes this file. */
	readonly debArch: string;
}

/** Keyed by the target name in targets.ts. macOS and Windows have no entry yet; see BINARIES `from`. */
export const RELEASE_ARTIFACTS: Readonly<Record<string, ReleaseArtifact>> = {
	"linux-arm64": {
		path: "pool/d/da/datadog-agent_7.82.1-1_arm64.deb",
		sha256: "221d19ada068062cb1e117ca4558ce076ce162c26a9e1323ec043971855e265f",
		size: 144584554,
		debArch: "arm64",
	},
	"linux-x86_64": {
		path: "pool/d/da/datadog-agent_7.82.1-1_amd64.deb",
		sha256: "2009d485f194ac47c1be7ac3212aaebc12803743d7242d81d6b6bfd4a1db0575",
		size: 160658506,
		debArch: "amd64",
	},
};

/** Where a binary sits inside the unpacked .deb, relative to `opt/datadog-agent/`. */
export const RELEASE_PATHS: Readonly<Record<string, string>> = {
	"trace-agent": "embedded/bin/trace-agent",
	"system-probe": "embedded/bin/system-probe",
	"security-agent": "embedded/bin/security-agent",
};

/**
 * The compiled eBPF objects system-probe loads, shipped beside it.
 *
 * Without these the binary starts, answers `version`, and cannot load a single program, which is the
 * shape of a feature that is present and does nothing. 26 objects, 42 MB, under this directory.
 */
export const EBPF_SOURCE_DIR = "embedded/share/system-probe";

/** Where the eBPF objects go in the shipped package, and what system-probe is pointed at to find them. */
export const EBPF_SHIP_DIR = "share/system-probe";

/** Targets that carry an extracted binary at all. */
export const extractableTargets = (): string[] =>
	Object.keys(RELEASE_ARTIFACTS);

/** Whether a target can supply extracted binaries; macOS and Windows still build their trace-agent. */
export const hasRelease = (targetName: string): boolean =>
	targetName in RELEASE_ARTIFACTS;

/** system-probe is Linux-only and security-agent is Linux and Windows, so the OS decides what is lifted. */
export const releaseBinariesFor = (os: OS): string[] =>
	os === "linux" ? ["trace-agent", "system-probe", "security-agent"] : [];
