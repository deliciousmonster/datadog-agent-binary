// The extraction step: reading a .deb's container, and refusing to write when the chain does not hold.
//
// The negative assertions are the ones that matter. "It extracted the binary" passes just as well on an
// extractor that never verified anything, so the tests that carry weight are the ones that hand it a
// failing chain and assert nothing reached the output directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	extractRelease,
	findDataMember,
	readArMembers,
	tarFlagFor,
	wantedFrom,
} from "../../dist/src/extract.js";
import { TARGETS, findTarget } from "../../dist/src/targets.js";
import { RELEASE_ARTIFACTS } from "../../dist/src/release.js";
import { extractedFor } from "../../dist/src/binaries.js";

const scratch = () => mkdtempSync(join(tmpdir(), "ddab-extract-"));

/** An `ar` archive holding the named members, in the format dpkg writes. */
function arArchive(members) {
	const parts = [Buffer.from("!<arch>\n", "latin1")];
	for (const [name, body] of members) {
		const data = Buffer.from(body, "latin1");
		const header =
			name.padEnd(16, " ") +
			"0".padEnd(12, " ") + // mtime
			"0".padEnd(6, " ") + // uid
			"0".padEnd(6, " ") + // gid
			"100644".padEnd(8, " ") + // mode
			String(data.length).padEnd(10, " ") +
			"`\n";
		parts.push(Buffer.from(header, "latin1"), data);
		// Members are padded to an even offset.
		if (data.length % 2) parts.push(Buffer.from("\n", "latin1"));
	}
	return new Uint8Array(Buffer.concat(parts));
}

test("reads the member table of an ar archive", () => {
	const bytes = arArchive([
		["debian-binary", "2.0\n"],
		["control.tar.xz", "control"],
		["data.tar.zst", "payload"],
	]);
	const members = readArMembers(bytes);
	assert.deepEqual(
		members.map((m) => m.name),
		["debian-binary", "control.tar.xz", "data.tar.zst"]
	);
	const data = members[2];
	assert.equal(
		Buffer.from(
			bytes.subarray(data.offset, data.offset + data.size)
		).toString(),
		"payload"
	);
});

// An odd-length member shifts every later offset by one. Without the padding rule the next header lands
// one byte early, the end marker check fails, and the .deb reads as corrupt - or worse, does not.
test("a member of odd length does not shift the members after it", () => {
	const bytes = arArchive([
		["debian-binary", "2.0\n"],
		["odd.txt", "abc"],
		["data.tar.gz", "payload"],
	]);
	const data = findDataMember(readArMembers(bytes));
	assert.equal(
		Buffer.from(
			bytes.subarray(data.offset, data.offset + data.size)
		).toString(),
		"payload"
	);
});

test("NEGATIVE: something that is not an ar archive is refused, not parsed", () => {
	assert.throws(
		() => readArMembers(new Uint8Array(Buffer.from("PK\x03\x04not a deb"))),
		/magic bytes/
	);
});

test("NEGATIVE: a header with no end marker is refused rather than read as a size", () => {
	const bytes = Buffer.concat([
		Buffer.from("!<arch>\n", "latin1"),
		Buffer.from("x".repeat(60), "latin1"),
	]);
	assert.throws(() => readArMembers(new Uint8Array(bytes)), /end marker/);
});

test("NEGATIVE: an archive with no data member names what it did hold", () => {
	const members = readArMembers(
		arArchive([
			["debian-binary", "2.0\n"],
			["control.tar.xz", "control"],
		])
	);
	assert.throws(() => findDataMember(members), /control\.tar\.xz/);
});

// The payload is identified by name, not by looking data-ish. A looser match takes the first member whose
// name happens to begin with "data", hands its bytes to tar, and reports a corrupt archive rather than the
// package having a shape this does not understand.
test("NEGATIVE: a member that merely starts with data is not taken for the payload", () => {
	const members = readArMembers(
		arArchive([
			["debian-binary", "2.0\n"],
			["database.txt", "not the payload"],
		])
	);
	assert.throws(() => findDataMember(members), /no data\.tar member/);
});

test("picks tar's flag from the member's own suffix", () => {
	assert.equal(tarFlagFor("data.tar.zst"), "--zstd");
	assert.equal(tarFlagFor("data.tar.xz"), "-J");
	assert.equal(tarFlagFor("data.tar.gz"), "-z");
	assert.equal(tarFlagFor("data.tar"), "");
});

// Guessing would hand tar an uncompressed read of a compressed file, which fails somewhere deeper with a
// message about the archive rather than about the compression.
test("NEGATIVE: a compression this cannot read is refused rather than guessed at", () => {
	assert.throws(() => tarFlagFor("data.tar.lz4"), /compression/);
});

test("wants every lifted binary and the objects on Linux", () => {
	const wanted = wantedFrom(findTarget("linux-arm64"));
	assert.deepEqual(wanted.binaries.map((b) => b.binary.shipsAs).sort(), [
		"process-agent",
		"security-agent",
		"system-probe",
	]);
	assert.equal(wanted.ebpf, true);
	for (const { payloadPath } of wanted.binaries)
		assert.match(payloadPath, /^embedded\/bin\//);
});

// macOS has no system-probe and no security-agent, so extraction there is not a smaller job, it is no job.
// A macOS run that reached the download would be spending 160 MB to unpack nothing.
test("wants nothing on a target with no extracted binary, and so asks for no eBPF", () => {
	const wanted = wantedFrom(findTarget("macos-arm64"));
	assert.deepEqual(wanted.binaries, []);
	assert.equal(wanted.ebpf, false);
});

test("a target with nothing to extract downloads nothing at all", async () => {
	const dir = scratch();
	try {
		let fetched = 0;
		const written = await extractRelease({
			target: findTarget("macos-arm64"),
			outputDir: join(dir, "bin"),
			ebpfDir: join(dir, "share"),
			workDir: join(dir, "work"),
			fetch: async () => {
				fetched += 1;
				return new Uint8Array();
			},
		});
		assert.deepEqual(written, []);
		assert.equal(
			fetched,
			0,
			"asked the network for a release it does not need"
		);
		assert.equal(existsSync(join(dir, "bin")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Everything the chain needs, all of it wrong, so each test spoils exactly the one thing it is about. */
function failingInputs() {
	const artifact = RELEASE_ARTIFACTS["linux-arm64"];
	return {
		artifact,
		fetch: async (url) =>
			new Uint8Array(Buffer.from(`not the real ${url}`, "utf8")),
		verifySignature: async () => ({ good: false }),
	};
}

// The load-bearing assertion of the whole file. An extractor that unpacks first and verifies second is an
// extractor with no verification in it, and the only way to tell the two apart is to hand it a failing
// chain and look at the disk.
test("NEGATIVE: a chain that does not hold writes nothing to the output directory", async () => {
	const dir = scratch();
	const outputDir = join(dir, "bin");
	try {
		await assert.rejects(
			extractRelease({
				target: findTarget("linux-arm64"),
				outputDir,
				ebpfDir: join(dir, "share"),
				workDir: join(dir, "work"),
				...failingInputs(),
			}),
			/refusing to extract/
		);
		assert.equal(
			existsSync(outputDir),
			false,
			"created the output directory for an artefact it refused"
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("NEGATIVE: the refusal names every step that failed, not just the first", async () => {
	const dir = scratch();
	try {
		const error = await extractRelease({
			target: findTarget("linux-arm64"),
			outputDir: join(dir, "bin"),
			ebpfDir: join(dir, "share"),
			workDir: join(dir, "work"),
			...failingInputs(),
		}).then(
			() => null,
			(e) => e
		);
		assert.ok(error, "extracted from an artefact that failed every check");
		assert.match(error.message, /not signed by a key gpg trusts/);
		assert.match(error.message, /Packages/);
		assert.match(error.message, /hashes to/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// A good signature by the wrong key is the interesting forgery: gpg says GOODSIG, and only the fingerprint
// comparison catches that whoever signed it is not Datadog.
test("NEGATIVE: a good signature from a key that is not Datadog's is refused", async () => {
	const dir = scratch();
	try {
		const error = await extractRelease({
			target: findTarget("linux-arm64"),
			outputDir: join(dir, "bin"),
			ebpfDir: join(dir, "share"),
			workDir: join(dir, "work"),
			...failingInputs(),
			verifySignature: async () => ({
				good: true,
				fingerprint: "0000000000000000000000000000000000000000",
			}),
		}).then(
			() => null,
			(e) => e
		);
		assert.ok(error);
		assert.match(error.message, /not by Datadog's APT key/);
		assert.equal(readdirSync(dir).includes("bin"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Windows security-agent is built rather than lifted, because the extraction source is a Debian package
// and cannot carry a Windows binary. A Windows leg that reached the download would refuse the whole build
// for an artefact it has no use for.
test("Windows extracts nothing, because its one lifted binary is built there instead", async () => {
	const dir = scratch();
	try {
		let fetched = 0;
		const written = await extractRelease({
			target: findTarget("windows-x86_64"),
			outputDir: join(dir, "bin"),
			ebpfDir: join(dir, "share"),
			workDir: join(dir, "work"),
			fetch: async () => {
				fetched += 1;
				return new Uint8Array();
			},
		});
		assert.deepEqual(written, []);
		assert.equal(fetched, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The invariant that catches the next one. `from: "release"` on a target with no pinned .deb is a build
// that downloads nothing, refuses, and takes the whole platform down with it, and the only place the two
// facts meet is here.
test("every target that lifts a binary has a release pinned for it", () => {
	for (const target of TARGETS) {
		if (extractedFor(target).length === 0) continue;
		assert.ok(
			RELEASE_ARTIFACTS[target.name],
			`${target.name} lifts ${extractedFor(target)
				.map((b) => b.shipsAs)
				.join(", ")} and release.ts pins no artefact for it`
		);
	}
});

// The other half: a pinned artefact nobody lifts from is 145 MB downloaded and thrown away.
test("no release is pinned for a target that lifts nothing", () => {
	for (const name of Object.keys(RELEASE_ARTIFACTS)) {
		assert.ok(
			extractedFor(findTarget(name)).length > 0,
			`${name} pins a release and lifts no binary out of it`
		);
	}
});
