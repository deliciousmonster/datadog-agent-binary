// Lifts the binaries this package does not build out of Datadog's own signed package.
//
// Nothing here trusts the download. `verifyRelease` walks the whole chain first, and this refuses to write
// a single byte until it passes, because an extractor that runs before the verifier is a verifier that does
// not exist. The failure mode being guarded is a mirror serving a different .deb, which looks exactly like
// a good one to anything that only checks the file arrived.
//
// A .deb is an `ar` archive holding `data.tar.<zst|xz|gz>`, and the payload paths are `./opt/datadog-agent/…`.
// Reading `ar` here rather than shelling out to `dpkg` keeps this working on the macOS and Windows runners,
// which have no dpkg, and `tar` is asked only for the members that are wanted.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { binaryFilename, extractedFor } from "./binaries.js";
import { logger } from "./log.js";
import { DATADOG_APT_KEY_URL, EBPF_SOURCE_DIR, RELEASE_ARTIFACTS, RELEASE_PATHS, } from "./release.js";
import { artifactUrl, packagesUrl, readGpgStatus, releaseUrls, verifyRelease, } from "./verify-release.js";
const exec = promisify(execFile);
/** Everything inside the .deb hangs off this. */
const PAYLOAD_ROOT = "opt/datadog-agent";
/**
 * Members of `data.tar` an `ar` archive holds, in the order the format allows them.
 *
 * The compression suffix moves between Debian releases (`gz` gave way to `xz`, and `zst` is current on
 * some), so the member is found by prefix rather than assumed.
 */
const DATA_MEMBER = /^data\.tar(\.(zst|xz|gz|bz2))?$/;
/**
 * Parse an `ar` archive header table.
 *
 * The format is a magic line then, per member, a 60-byte header whose fields are space-padded ASCII, and
 * the data padded to an even offset. GNU long names via `//` are not handled: no Datadog .deb uses them,
 * and a silent wrong answer is worse than a refusal, so an unrecognised name is returned as-is for the
 * caller to fail on rather than guessed at.
 */
export function readArMembers(bytes) {
    const text = new TextDecoder("latin1");
    if (text.decode(bytes.subarray(0, 8)) !== "!<arch>\n")
        throw new Error("not an ar archive: the magic bytes are wrong");
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
export function findDataMember(members) {
    const found = members.find((m) => DATA_MEMBER.test(m.name));
    if (!found)
        throw new Error(`no data.tar member in the package; it holds ${members.map((m) => m.name).join(", ")}`);
    return found;
}
/** `tar`'s flag for the compression a member's name declares. Unknown suffixes are refused, not guessed. */
export function tarFlagFor(memberName) {
    const suffix = memberName.split(".").pop();
    const flags = {
        zst: "--zstd",
        xz: "-J",
        gz: "-z",
        bz2: "-j",
    };
    if (memberName === "data.tar")
        return "";
    const flag = flags[suffix ?? ""];
    if (!flag)
        throw new Error(`data member ${memberName} uses a compression this cannot read`);
    return flag;
}
/** What one target needs out of the release: binaries by their path in the payload, plus the eBPF objects. */
export function wantedFrom(target) {
    const binaries = extractedFor(target).map((binary) => {
        const payloadPath = RELEASE_PATHS[binary.shipsAs];
        if (!payloadPath)
            throw new Error(`${binary.shipsAs} is marked from: "release" and release.ts says nothing about where it lives`);
        return { binary, payloadPath };
    });
    return {
        binaries,
        // The objects are system-probe's and useless without it, so they follow it rather than the target.
        ebpf: binaries.some(({ binary }) => binary.shipsAs === "system-probe"),
    };
}
const fetchBytes = async (url) => {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${url} answered ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
};
const asText = (bytes) => new TextDecoder().decode(bytes);
/**
 * Verify Datadog's signature over the Release file, using the caller's gpg.
 *
 * The key is imported into a throwaway home so this never touches whatever keyring the runner has, and so
 * a machine that already trusts some other Datadog key cannot make this pass for the wrong reason.
 *
 * That home goes under the system temp directory rather than beside the download, and the reason is a
 * length limit rather than tidiness. gpg 2 talks to gpg-agent over a unix socket inside GNUPGHOME, and a
 * unix socket path is capped at 104 bytes on macOS and 108 on Linux. A build tree nested deep enough puts
 * `<workDir>/gnupg/S.gpg-agent` past that, and what gpg then reports is `can't connect to the gpg-agent:
 * File name too long`, which reads as a broken gpg installation rather than as a path that is too long.
 * Measured here on 2026-09-10 under a session scratch directory, at 104 characters.
 */
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
        const status = await exec("gpg", [
            "--batch",
            "--status-fd",
            "1",
            "--verify",
            files.signature,
            files.release,
        ], { env }).catch((error) => ({ stdout: error.stdout ?? "" }));
        return readGpgStatus(status.stdout ?? "");
    }
    finally {
        // The agent holds this open, so it is asked to stop before the directory goes. A failure to stop it
        // is not a failure to verify, and the directory is under the system temp anyway.
        await exec("gpgconf", ["--kill", "gpg-agent"], { env }).catch(() => { });
        await rm(home, { recursive: true, force: true });
    }
}
/**
 * Put every `from: "release"` binary for one target into `outputDir`, or refuse and write nothing.
 *
 * Returns the paths written, matching what the build step returns, so the packaging step does not care
 * which half a binary came from.
 */
export async function extractRelease({ target, outputDir, ebpfDir, workDir, fetch: get = fetchBytes, verifySignature = checkSignature, artifact = RELEASE_ARTIFACTS[target.name], }) {
    const wanted = wantedFrom(target);
    if (wanted.binaries.length === 0)
        return [];
    if (!artifact)
        throw new Error(`${target.name} needs ${wanted.binaries.map((b) => b.binary.shipsAs).join(", ")} from a Datadog ` +
            `release and release.ts pins none for it`);
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
    for (const line of check.checked)
        logger.info(`  verified: ${line}`);
    if (!check.ok)
        throw new Error(`refusing to extract from ${artifact.path}:\n  ${check.failures.join("\n  ")}`);
    // Only now does anything get written.
    const debFile = join(workDir, basename(artifact.path));
    await writeFile(debFile, bytes);
    const data = findDataMember(readArMembers(bytes));
    const payload = join(workDir, data.name);
    await writeFile(payload, bytes.subarray(data.offset, data.offset + data.size));
    const unpacked = join(workDir, "payload");
    await mkdir(unpacked, { recursive: true });
    const members = [
        ...wanted.binaries.map(({ payloadPath }) => `./${PAYLOAD_ROOT}/${payloadPath}`),
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
//# sourceMappingURL=extract.js.map