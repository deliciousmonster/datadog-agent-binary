// @ts-check
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
/**
 * @typedef {object} ReleaseArtifact
 * @property {string} path Path under the apt pool, joined to DATADOG_APT_BASE.
 * @property {string} sha256
 * @property {number} size
 * @property {string} debArch Debian architecture, which names the Packages index that hashes this file.
 */

/** Keyed by the target name in targets.ts. macOS and Windows have no entry yet; see BINARIES `from`. */
/** @type {Readonly<Record<string, ReleaseArtifact>>} */
export const RELEASE_ARTIFACTS = {
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
/** @type {Readonly<Record<string, string>>} */
export const RELEASE_PATHS = {
	"trace-agent": "embedded/bin/trace-agent",
	"process-agent": "embedded/bin/process-agent",
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

/** Whether a target can supply extracted binaries at all. */
/** @param {string} targetName @returns {boolean} */
export const hasRelease = (targetName) => targetName in RELEASE_ARTIFACTS;

// There is deliberately no second list of which binaries come from a release. `binaries.ts` carries that in
// each descriptor's `from` field, and `extractedFor(target)` reads it. A helper here would be a second
// answer to the same question, and it was already wrong once: it named the trace-agent, which measurement
// moved back to a build after this file was written.
