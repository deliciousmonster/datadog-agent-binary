// @ts-check
// Lifts what this package does not build out of Datadog's signed .deb, writing no byte until verifyRelease
// passes. `ar` is read here rather than shelling to `dpkg`, which the macOS and Windows runners do not have.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { binaryFilename, extractedFor } from "./binaries.js";
import { logger } from "./log.js";
import {
	DATADOG_APT_KEY_URL,
	EBPF_SOURCE_DIR,
	RELEASE_ARTIFACTS,
	RELEASE_PATHS,
} from "./release.js";

/** @typedef {import("./binaries.js").AgentBinary} AgentBinary */
/** @typedef {import("./release.js").ReleaseArtifact} ReleaseArtifact */
/** @typedef {import("./toolchain.js").Target} Target */
import {
	artifactUrl,
	packagesUrl,
	readGpgStatus,
	releaseUrls,
	verifyRelease,
} from "./verify-release.js";

const exec = promisify(execFile);

/** Everything inside the .deb hangs off this. */
const PAYLOAD_ROOT = "opt/datadog-agent";

/**
 * The `data.tar` member an `ar` archive holds. The compression suffix moves between Debian releases, so it
 * is found by prefix rather than assumed.
 */
const DATA_MEMBER = /^data\.tar(\.(zst|xz|gz|bz2))?$/;

/**
 * @typedef {object} ArArchiveMember
 * @property {string} name
 * @property {number} offset
 * @property {number} size
 */

/**
 * Parse an `ar` header table: a magic line, then 60-byte space-padded headers with data at even offsets.
 * GNU long names are not handled, and an unrecognised name comes back as-is for the caller to refuse.
 */
/** @param {Uint8Array} bytes @returns {ArArchiveMember[]} */
export function readArMembers(bytes) {
	const text = new TextDecoder("latin1");
	if (text.decode(bytes.subarray(0, 8)) !== "!<arch>\n")
		throw new Error("not an ar archive: the magic bytes are wrong");
	/** @type {ArArchiveMember[]} */
	const members = [];
	let at = 8;
	while (at + 60 <= bytes.byteLength) {
		const header = text.decode(bytes.subarray(at, at + 60));
		if (header.slice(58, 60) !== "`\n")
			throw new Error(`ar header at ${at} has no end marker`);
		const name = header.slice(0, 16).trim().replace(/\/$/, "");
		const size = Number.parseInt(header.slice(48, 58).trim(), 10);
		if (!Number.isInteger(size) || size < 0)
			throw new Error(`ar member ${name} has an unreadable size`);
		const offset = at + 60;
		members.push({ name, offset, size });
		// Members are padded to an even boundary; the padding byte is not part of the member.
		at = offset + size + (size % 2);
	}
	return members;
}

/** The compressed payload member, or a refusal naming what was there instead. */
/** @param {readonly ArArchiveMember[]} members */
export function findDataMember(members) {
	const found = members.find((m) => DATA_MEMBER.test(m.name));
	if (!found)
		throw new Error(
			`no data.tar member in the package; it holds ${members.map((m) => m.name).join(", ")}`
		);
	return found;
}

/** `tar`'s flag for the compression a member's name declares. Unknown suffixes are refused, not guessed. */
/** @param {string} memberName @returns {string} */
export function tarFlagFor(memberName) {
	const suffix = memberName.split(".").pop();
	/** @type {Record<string, string>} */
	const flags = {
		zst: "--zstd",
		xz: "-J",
		gz: "-z",
		bz2: "-j",
	};
	if (memberName === "data.tar") return "";
	const flag = flags[suffix ?? ""];
	if (!flag)
		throw new Error(
			`data member ${memberName} uses a compression this cannot read`
		);
	return flag;
}

/** What one target needs out of the release: binaries by their path in the payload, plus the eBPF objects. */
/**
 * @param {Target} target
 * @returns {{ binaries: { binary: AgentBinary, payloadPath: string }[], ebpf: boolean }}
 */
export function wantedFrom(target) {
	const binaries = extractedFor(target).map((binary) => {
		const payloadPath = RELEASE_PATHS[binary.shipsAs];
		if (!payloadPath)
			throw new Error(
				`${binary.shipsAs} is marked from: "release" and release.ts says nothing about where it lives`
			);
		return { binary, payloadPath };
	});
	return {
		binaries,
		// The objects are system-probe's and useless without it, so they follow it rather than the target.
		ebpf: binaries.some(({ binary }) => binary.shipsAs === "system-probe"),
	};
}

/** @typedef {(url: string) => Promise<Uint8Array>} Fetcher */

/**
 * What a gpg verify of the detached signature reported. Injected so the refusal path is testable.
 *
 * @typedef {(release: Uint8Array, signature: Uint8Array, key: Uint8Array, workDir: string) =>
 *   Promise<{ good: boolean, fingerprint?: string }>} SignatureCheck
 */

/** @type {Fetcher} */
const fetchBytes = async (url) => {
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(
			`${url} answered ${response.status} ${response.statusText}`
		);
	return new Uint8Array(await response.arrayBuffer());
};

const asText = (/** @type {Uint8Array} */ bytes) =>
	new TextDecoder().decode(bytes);

/**
 * Verify Datadog's signature using the caller's gpg, with the key in a throwaway home so a runner that
 * trusts another Datadog key cannot pass this. Under the system temp: the agent socket is capped at 104 bytes.
 */
/** @type {SignatureCheck} */
export async function checkSignature(release, signature, key, workDir) {
	const home = await mkdtemp(join(tmpdir(), "ddab-gpg-"));
	const files = {
		key: join(workDir, "datadog.asc"),
		release: join(workDir, "Release"),
		signature: join(workDir, "Release.gpg"),
	};
	await writeFile(files.key, key);
	await writeFile(files.release, release);
	await writeFile(files.signature, signature);
	const env = { ...process.env, GNUPGHOME: home };
	try {
		await exec("gpg", ["--batch", "--quiet", "--import", files.key], { env });
		// gpg exits non-zero on a bad signature, and the status output is what carries the verdict either
		// way, so the rejection is read rather than inferred from the exit code.
		const status = await exec(
			"gpg",
			[
				"--batch",
				"--status-fd",
				"1",
				"--verify",
				files.signature,
				files.release,
			],
			{ env }
		).catch((/** @type {{ stdout?: string }} */ error) => ({
			stdout: error.stdout ?? "",
		}));
		return readGpgStatus(status.stdout ?? "");
	} finally {
		// The agent holds this open, so it is asked to stop before the directory goes. A failure to stop it
		// is not a failure to verify, and the directory is under the system temp anyway.
		await exec("gpgconf", ["--kill", "gpg-agent"], { env }).catch(() => {});
		await rm(home, { recursive: true, force: true });
	}
}

/**
 * @typedef {object} ExtractOptions
 * @property {Target} target
 * @property {string} outputDir Where the binaries land, beside the built ones.
 * @property {string} ebpfDir Where the eBPF objects land. Not under `outputDir`: they are data, not
 *   executables.
 * @property {string} workDir
 * @property {Fetcher} [fetch]
 * @property {SignatureCheck} [verifySignature]
 * @property {ReleaseArtifact} [artifact]
 */

/**
 * Put every `from: "release"` binary into `outputDir`, or refuse and write nothing. Returns what the build
 * step returns, so the staging does not care which half a binary came from.
 */
/** @param {ExtractOptions} options @returns {Promise<string[]>} */
export async function extractRelease({
	target,
	outputDir,
	ebpfDir,
	workDir,
	fetch: get = fetchBytes,
	verifySignature = checkSignature,
	artifact = RELEASE_ARTIFACTS[target.name],
}) {
	const wanted = wantedFrom(target);
	if (wanted.binaries.length === 0) return [];
	if (!artifact)
		throw new Error(
			`${target.name} needs ${wanted.binaries.map((b) => b.binary.shipsAs).join(", ")} from a Datadog ` +
				`release and release.ts pins none for it`
		);

	await mkdir(workDir, { recursive: true });
	const urls = releaseUrls();
	logger.info(`Verifying Datadog's release for ${target.name}`);
	const [release, signature, key, packages, bytes] = await Promise.all([
		get(urls.release),
		get(urls.signature),
		get(DATADOG_APT_KEY_URL),
		get(packagesUrl(artifact.debArch)),
		get(artifactUrl(artifact)),
	]);

	const check = verifyRelease({
		artifact,
		bytes,
		release: asText(release),
		packages: asText(packages),
		signature: await verifySignature(release, signature, key, workDir),
	});
	for (const line of check.checked) logger.info(`  verified: ${line}`);
	if (!check.ok)
		throw new Error(
			`refusing to extract from ${artifact.path}:\n  ${check.failures.join("\n  ")}`
		);

	// Only now does anything get written.
	const debFile = join(workDir, basename(artifact.path));
	await writeFile(debFile, bytes);
	const data = findDataMember(readArMembers(bytes));
	const payload = join(workDir, data.name);
	await writeFile(
		payload,
		bytes.subarray(data.offset, data.offset + data.size)
	);

	const unpacked = join(workDir, "payload");
	await mkdir(unpacked, { recursive: true });
	const members = [
		...wanted.binaries.map(
			({ payloadPath }) => `./${PAYLOAD_ROOT}/${payloadPath}`
		),
		...(wanted.ebpf ? [`./${PAYLOAD_ROOT}/${EBPF_SOURCE_DIR}`] : []),
	];
	const flag = tarFlagFor(data.name);
	await exec("tar", [
		...(flag ? [flag] : []),
		"-xf",
		payload,
		"-C",
		unpacked,
		...members,
	]);

	/** @type {string[]} */
	const written = [];
	for (const { binary, payloadPath } of wanted.binaries) {
		const from = join(unpacked, PAYLOAD_ROOT, payloadPath);
		const to = join(outputDir, binaryFilename(binary, target));
		await mkdir(outputDir, { recursive: true });
		await writeFile(to, await readFile(from), { mode: 0o755 });
		written.push(to);
		logger.info(`Extracted ${binary.shipsAs} from ${artifact.path}`);
	}
	if (wanted.ebpf) {
		const from = join(unpacked, PAYLOAD_ROOT, EBPF_SOURCE_DIR);
		const to = ebpfDir;
		await mkdir(to, { recursive: true });
		// The whole directory, because system-probe picks the object matching the running kernel and a
		// subset would work on the machine that chose it and fail on the operator's.
		await exec("cp", ["-R", `${from}/.`, to]);
		written.push(to);
		logger.info(`Extracted the precompiled eBPF objects to ${to}`);
	}

	await rm(debFile, { force: true });
	await rm(payload, { force: true });
	return written;
}
