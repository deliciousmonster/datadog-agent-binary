// @ts-check
// The release this package lifts from, and the pins verifyRelease checks it against: Datadog's key signs
// Release, Release hashes Packages, Packages hashes the .deb, and the .deb's own SHA256 is below.

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
 * One artefact per target that ships an extracted binary. The pins were read out of the signed `Packages`
 * index rather than computed from a download, so the pin and the repository agreed before either was written.
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
 * The compiled eBPF objects system-probe loads: 26 of them, 42 MB. Without these it starts, answers
 * `version`, and loads not one program.
 */
export const EBPF_SOURCE_DIR = "embedded/share/system-probe";

/** Where the eBPF objects go in the shipped package, and what system-probe is pointed at to find them. */
export const EBPF_SHIP_DIR = "share/system-probe";

/** Whether a target can supply extracted binaries at all. */
/** @param {string} targetName @returns {boolean} */
export const hasRelease = (targetName) => targetName in RELEASE_ARTIFACTS;

// No second list of which binaries come from a release: binaries.js's `from` field carries that. One here
// was wrong once already, naming the trace-agent that measurement moved back to a build.
