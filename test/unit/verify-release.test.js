// Three of the four binaries are lifted from Datadog's own release rather than built here, so what stands
// between a mirror and this package's registry entry is the chain in src/verify-release.ts. A pin alone
// only says a file has not changed since somebody wrote a line down; it never says that line was right.
// These assert the chain refuses, because a verifier that cannot fail is not a verifier.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RELEASE_ARTIFACTS } from "../../agent-build/release.js";
import {
	hashFromPackages,
	hashFromRelease,
	readGpgStatus,
	sha256,
	verifyRelease,
} from "../../agent-build/verify-release.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "apt");
const read = (name) => readFileSync(join(FIXTURES, name), "utf-8");
const RELEASE = read("Release");
const PACKAGES = {
	arm64: read("Packages.arm64"),
	amd64: read("Packages.amd64"),
};

const DATADOG_FP = "5F1E256061D813B125E156E8E6266D4AC0962C7D";
const goodSig = { good: true, fingerprint: DATADOG_FP };

describe("reading a signed Release", () => {
	it("takes the SHA256 section, not the MD5 section that names the same path", () => {
		// The real Release carries MD5Sum, SHA1 and SHA256, and the same paths appear in each. A read that
		// matched on the path alone took the MD5, which is 32 hex characters and can never match a SHA256.
		const got = hashFromRelease(RELEASE, "7/binary-arm64/Packages");
		assert.equal(got.length, 64, `took a ${got.length}-character digest`);
		assert.equal(
			got,
			createHash("sha256").update(PACKAGES.arm64).digest("hex")
		);
	});

	it("NEGATIVE: answers undefined for a path the Release does not name", () => {
		assert.equal(
			hashFromRelease(RELEASE, "7/binary-riscv64/Packages"),
			undefined
		);
	});

	it("NEGATIVE: a later section carrying the same path cannot overwrite the answer", () => {
		// The trap has to look like a real digest, or the regex rejects it for its shape and the section
		// bound is never exercised. SHA512 lines are 128 characters; the first 64 of one are valid hex.
		const decoy = "f".repeat(64);
		const trailing = `${RELEASE}SHA512:\n ${decoy} 980 7/binary-arm64/Packages\n`;
		assert.equal(
			hashFromRelease(trailing, "7/binary-arm64/Packages"),
			createHash("sha256").update(PACKAGES.arm64).digest("hex"),
			"the read has to stop at the end of the SHA256 section"
		);
	});

	it("NEGATIVE: a path only a later section names has no SHA256, and is not given one", () => {
		// This is what the section bound is for. Returning on the first match already handles a path that
		// appears in both, because SHA256 precedes SHA512; the case that needs the bound is a path the
		// SHA256 section does not carry at all, where the scan would otherwise run on into the next one.
		const decoy = "f".repeat(64);
		const trailing = `${RELEASE}SHA512:\n ${decoy} 980 7/binary-riscv64/Packages\n`;
		assert.equal(
			hashFromRelease(trailing, "7/binary-riscv64/Packages"),
			undefined,
			"a digest from another section is not a SHA256 and must not be returned as one"
		);
	});

	it("NEGATIVE: an earlier MD5 section for the same path is not taken", () => {
		// This is the bug that was actually written: a read matching on the path alone took whichever
		// section came first, and MD5Sum is above SHA256 in the real file.
		const md5 = /^ ([0-9a-f]{32}) \d+ 7\/binary-arm64\/Packages$/m.exec(
			RELEASE
		);
		assert.ok(
			md5,
			"the fixture has to carry the MD5 trap for this to mean anything"
		);
		assert.notEqual(
			hashFromRelease(RELEASE, "7/binary-arm64/Packages"),
			md5[1]
		);
	});
});

describe("reading a Packages index", () => {
	it("takes the SHA256 from the stanza carrying our filename", () => {
		const artifact = RELEASE_ARTIFACTS["linux-arm64"];
		assert.equal(
			hashFromPackages(PACKAGES.arm64, artifact.path),
			artifact.sha256
		);
	});

	it("the pin in release.ts is what the signed repository says, for every target", () => {
		// This is the assertion that catches a mistyped or stale pin. The stanzas are verbatim from the
		// repository on 2026-09-10.
		for (const [name, artifact] of Object.entries(RELEASE_ARTIFACTS)) {
			const index = PACKAGES[artifact.debArch];
			assert.ok(index, `no fixture for ${artifact.debArch}`);
			assert.equal(
				hashFromPackages(index, artifact.path),
				artifact.sha256,
				`the pin for ${name} disagrees with the repository`
			);
		}
	});

	it("NEGATIVE: does not return another package's digest", () => {
		const other = PACKAGES.arm64.replace(
			/^Filename: .*$/m,
			"Filename: pool/d/da/datadog-dogstatsd_7.82.1-1_arm64.deb"
		);
		assert.equal(
			hashFromPackages(other, RELEASE_ARTIFACTS["linux-arm64"].path),
			undefined,
			"a stanza for a different file cannot answer for ours"
		);
	});
});

describe("what gpg said", () => {
	it("takes the fingerprint from VALIDSIG, which is the only line carrying all forty characters", () => {
		const status =
			"[GNUPG:] GOODSIG E6266D4AC0962C7D Datadog, Inc. APT key\n" +
			`[GNUPG:] VALIDSIG ${DATADOG_FP} 2026-09-09 1788955378 0 4 0 1 10 00 ${DATADOG_FP}\n`;
		assert.deepEqual(readGpgStatus(status), {
			good: true,
			fingerprint: DATADOG_FP,
		});
	});

	it("NEGATIVE: BADSIG is not a pass, whatever else the run printed", () => {
		const status = `[GNUPG:] VALIDSIG ${DATADOG_FP} x\n[GNUPG:] BADSIG E6266D4AC0962C7D Datadog\n`;
		assert.deepEqual(readGpgStatus(status), { good: false });
	});

	it("NEGATIVE: a run that printed no verdict at all is not a pass", () => {
		for (const quiet of [
			"",
			"gpg: keyring created\n",
			"[GNUPG:] NO_PUBKEY abc\n",
		])
			assert.equal(readGpgStatus(quiet).good, false, JSON.stringify(quiet));
	});
});

describe("the chain, end to end", () => {
	const artifact = RELEASE_ARTIFACTS["linux-arm64"];
	const bytes = new TextEncoder().encode("not the artefact");
	const base = {
		artifact,
		bytes,
		release: RELEASE,
		packages: PACKAGES.arm64,
		signature: goodSig,
	};

	it("refuses an unsigned Release before anything below it is believed", () => {
		const got = verifyRelease({ ...base, signature: { good: false } });
		assert.equal(got.ok, false);
		assert.ok(
			got.failures.some((f) => /not signed by a key gpg trusts/.test(f))
		);
	});

	it("refuses a Release signed by the wrong key", () => {
		const got = verifyRelease({
			...base,
			signature: { good: true, fingerprint: "0".repeat(40) },
		});
		assert.equal(got.ok, false);
		assert.ok(
			got.failures.some((f) => f.includes(DATADOG_FP)),
			`the failure has to name the key that was expected: ${got.failures}`
		);
	});

	it("refuses a Packages index the signed Release does not hash", () => {
		const tampered = `${PACKAGES.arm64}\nX-Injected: yes\n`;
		const got = verifyRelease({ ...base, packages: tampered });
		assert.equal(got.ok, false);
		assert.ok(
			got.failures.some((f) => /signed Release says/.test(f)),
			`a modified index must not pass: ${got.failures}`
		);
	});

	it("refuses when the repository and the pin disagree, and says both", () => {
		const republished = PACKAGES.arm64.replace(
			/^SHA256: [0-9a-f]{64}$/m,
			`SHA256: ${"b".repeat(64)}`
		);
		// The Release has to keep hashing the index, or this fails for the previous reason instead.
		const release = RELEASE.replace(
			hashFromRelease(RELEASE, "7/binary-arm64/Packages"),
			createHash("sha256").update(republished).digest("hex")
		);
		const got = verifyRelease({ ...base, packages: republished, release });
		assert.equal(got.ok, false);
		const disagreement = got.failures.find((f) =>
			/Either the pin is stale/.test(f)
		);
		assert.ok(disagreement, `no disagreement reported: ${got.failures}`);
		assert.ok(
			disagreement.includes(artifact.sha256),
			"the failure must name the pin"
		);
		assert.ok(
			disagreement.includes("b".repeat(64)),
			"and what the repository says"
		);
	});

	it("refuses bytes that do not hash to the pin", () => {
		const got = verifyRelease(base);
		assert.equal(got.ok, false);
		assert.ok(
			got.failures.some((f) => /not the pinned/.test(f)),
			`the downloaded bytes are not the artefact and must be refused: ${got.failures}`
		);
	});

	it("reports every broken link, not just the first", () => {
		const got = verifyRelease({
			...base,
			signature: { good: false },
			packages: "Package: nothing\n",
		});
		assert.ok(
			got.failures.length >= 3,
			`whoever has to fix this needs all of it: ${JSON.stringify(got.failures)}`
		);
		assert.equal(got.ok, false);
	});

	it("passes only when every link holds", () => {
		// The one place the artefact's own bytes are stood in for: hashing 144 MB in a unit test buys
		// nothing the pin comparison does not already assert, and the download path asserts it for real.
		const real = new TextEncoder().encode("stand-in");
		const got = verifyRelease({
			...base,
			bytes: real,
			artifact: { ...artifact, sha256: sha256(real), size: real.byteLength },
			packages: PACKAGES.arm64.replace(
				/^SHA256: [0-9a-f]{64}$/m,
				`SHA256: ${sha256(real)}`
			),
			release: RELEASE.replace(
				hashFromRelease(RELEASE, "7/binary-arm64/Packages"),
				createHash("sha256")
					.update(
						PACKAGES.arm64.replace(
							/^SHA256: [0-9a-f]{64}$/m,
							`SHA256: ${sha256(real)}`
						)
					)
					.digest("hex")
			),
		});
		assert.deepEqual(got.failures, []);
		assert.equal(got.ok, true);
		assert.equal(
			got.checked.length,
			4,
			"all four links have to be reported checked"
		);
	});

	it("NEGATIVE: a size that disagrees with the pin fails even when the hash matches", () => {
		const real = new TextEncoder().encode("stand-in");
		const packages = PACKAGES.arm64.replace(
			/^SHA256: [0-9a-f]{64}$/m,
			`SHA256: ${sha256(real)}`
		);
		const got = verifyRelease({
			...base,
			bytes: real,
			artifact: { ...artifact, sha256: sha256(real), size: 999_999 },
			packages,
			release: RELEASE.replace(
				hashFromRelease(RELEASE, "7/binary-arm64/Packages"),
				createHash("sha256").update(packages).digest("hex")
			),
		});
		assert.equal(got.ok, false);
		assert.ok(got.failures.some((f) => /bytes, not the pinned/.test(f)));
	});
});
