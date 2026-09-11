// @ts-check
// Proves a downloaded artefact is the one pinned, before anything is extracted. A pin alone says the file
// has not changed, never that the line was right; the signature chain is what makes it right.

import { createHash } from "node:crypto";

import {
	DATADOG_APT_BASE,
	DATADOG_APT_COMPONENT,
	DATADOG_APT_FINGERPRINT,
	DATADOG_APT_SUITE,
} from "./release.js";

/** @typedef {import("./release.js").ReleaseArtifact} ReleaseArtifact */

/** @param {Uint8Array} bytes @returns {string} */
export const sha256 = (bytes) =>
	createHash("sha256").update(bytes).digest("hex");

/** URL of the signed Release file and its detached signature, for one suite. */
/** @param {string} [base] @param {string} [suite] */
export const releaseUrls = (
	base = DATADOG_APT_BASE,
	suite = DATADOG_APT_SUITE
) => ({
	release: `${base}/dists/${suite}/Release`,
	signature: `${base}/dists/${suite}/Release.gpg`,
});

/** @param {string} debArch @param {string} [base] @param {string} [suite] @param {string} [component] */
export const packagesUrl = (
	debArch,
	base = DATADOG_APT_BASE,
	suite = DATADOG_APT_SUITE,
	component = DATADOG_APT_COMPONENT
) => `${base}/dists/${suite}/${component}/binary-${debArch}/Packages`;

/** @param {ReleaseArtifact} artifact @param {string} [base] */
export const artifactUrl = (artifact, base = DATADOG_APT_BASE) =>
	`${base}/${artifact.path}`;

/**
 * The SHA256 a signed Release gives for one path. The same paths appear under MD5Sum, SHA1 and SHA256, so a
 * grep for the path alone takes whichever comes first, which is the MD5.
 */
/** @param {string} release @param {string} path @returns {string | undefined} */
export function hashFromRelease(release, path) {
	let inSection = false;
	for (const line of release.split("\n")) {
		if (/^SHA256:\s*$/.test(line)) {
			inSection = true;
			continue;
		}
		// Any other unindented `Key:` ends the section.
		if (inSection && /^\S+:/.test(line)) break;
		if (!inSection) continue;
		const match = /^\s+([0-9a-f]{64})\s+\d+\s+(\S+)\s*$/.exec(line);
		if (match && match[2] === path) return match[1];
	}
	return undefined;
}

/**
 * The SHA256 a Packages index gives for one pool path, from the stanza whose `Filename:` names it. The
 * first SHA256 in the file belongs to some other package.
 */
/** @param {string} packages @param {string} poolPath @returns {string | undefined} */
export function hashFromPackages(packages, poolPath) {
	for (const stanza of packages.split(/\n\n+/)) {
		if (
			!new RegExp(`^Filename:\\s*${escapeRe(poolPath)}\\s*$`, "m").test(stanza)
		)
			continue;
		const match = /^SHA256:\s*([0-9a-f]{64})\s*$/m.exec(stanza);
		return match ? match[1] : undefined;
	}
	return undefined;
}

const escapeRe = (/** @type {string} */ s) =>
	s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @typedef {object} ReleaseCheck
 * @property {boolean} ok
 * @property {readonly string[]} failures
 * @property {readonly string[]} checked
 */

/**
 * @typedef {object} VerifyInputs
 * @property {ReleaseArtifact} artifact
 * @property {Uint8Array} bytes Raw bytes of the .deb.
 * @property {string} release
 * @property {string} packages
 * @property {{ good: boolean, fingerprint?: string }} signature What a gpg verify of Release.gpg against
 *   Release reported. The caller runs gpg because spawning is the caller's business here as everywhere
 *   else in this package.
 */

/**
 * Walk the chain and report every step that failed, not the first. All four have to hold, so `ok` is the
 * conjunction and the failures are for whoever fixes it.
 */
/** @param {VerifyInputs} inputs @returns {ReleaseCheck} */
export function verifyRelease({
	artifact,
	bytes,
	release,
	packages,
	signature,
}) {
	/** @type {string[]} */
	const failures = [];
	/** @type {string[]} */
	const checked = [];

	if (!signature.good)
		failures.push(
			"the Release file is not signed by a key gpg trusts, so nothing below it can be believed"
		);
	else if (
		normaliseFingerprint(signature.fingerprint) !== DATADOG_APT_FINGERPRINT
	)
		failures.push(
			`the Release file is signed by ${signature.fingerprint ?? "an unnamed key"}, not by Datadog's ` +
				`APT key ${DATADOG_APT_FINGERPRINT}`
		);
	else checked.push("Release signed by Datadog's APT key");

	const indexPath = `${DATADOG_APT_COMPONENT}/binary-${artifact.debArch}/Packages`;
	const wantIndex = hashFromRelease(release, indexPath);
	const gotIndex = sha256(new TextEncoder().encode(packages));
	if (!wantIndex)
		failures.push(`the signed Release names no SHA256 for ${indexPath}`);
	else if (wantIndex !== gotIndex)
		failures.push(
			`${indexPath} hashes to ${gotIndex}, and the signed Release says ${wantIndex}`
		);
	else checked.push(`${indexPath} matches the signed Release`);

	const wantDeb = hashFromPackages(packages, artifact.path);
	if (!wantDeb)
		failures.push(`the Packages index carries no entry for ${artifact.path}`);
	else if (wantDeb !== artifact.sha256)
		failures.push(
			`the pin for ${artifact.path} is ${artifact.sha256}, and the repository says ${wantDeb}. ` +
				`Either the pin is stale or the artefact was republished; do not extract from it until that is settled`
		);
	else checked.push(`${artifact.path} matches the pin and the repository`);

	const gotDeb = sha256(bytes);
	if (gotDeb !== artifact.sha256)
		failures.push(
			`the downloaded ${artifact.path} hashes to ${gotDeb}, not the pinned ${artifact.sha256}`
		);
	else if (bytes.byteLength !== artifact.size)
		// Reachable only if SHA256 collided, which is the point of asserting it separately: the size is a
		// second, independent statement about the same file and costs nothing.
		failures.push(
			`the downloaded ${artifact.path} is ${bytes.byteLength} bytes, not the pinned ${artifact.size}`
		);
	else checked.push("the downloaded artefact matches the pin");

	return { ok: failures.length === 0, failures, checked };
}

/** gpg prints a fingerprint with no separators; a human writing one down uses spaces. Compare neither way. */
const normaliseFingerprint = (/** @type {string | undefined} */ value) =>
	(value ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * What a `gpg --status-fd` run said. VALIDSIG carries the full fingerprint and GOODSIG only the key id, so
 * one gives the fingerprint and either gives the verdict; neither is not a pass.
 */
/** @param {string} status @returns {{ good: boolean, fingerprint?: string }} */
export function readGpgStatus(status) {
	if (/^\[GNUPG:\] BADSIG /m.test(status)) return { good: false };
	const valid = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/m.exec(status);
	const good = /^\[GNUPG:\] GOODSIG /m.test(status);
	if (!good && !valid) return { good: false };
	return { good: true, fingerprint: valid?.[1] };
}
