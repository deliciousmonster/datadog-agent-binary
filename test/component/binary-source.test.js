// Which binaries this package compiles and which it lifts out of Datadog's signed release. The split is a
// measurement, not a preference, and these assert the measurement rather than the intent.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BINARIES,
	binariesFor,
	builtFor,
	extractedFor,
} from "../../agent-build/binaries.js";
import { TARGETS } from "../../agent-build/toolchain.js";

describe("where each binary comes from", () => {
	it("only the core agent and the trace-agent are built here", () => {
		// The core agent because it is the one that links libdatadog-agent-rtloader, so it is the only one
		// that has to be compiled to come out Python-free. The trace-agent because stripped it lands within
		// 49 KB of Datadog's, so lifting it would trade provenance on the binary this package exists to fix
		// for nothing.
		assert.deepEqual(
			BINARIES.filter((b) => b.from === "build").map((b) => b.shipsAs),
			["datadog-agent", "trace-agent"]
		);
	});

	it("system-probe and security-agent are lifted from the release", () => {
		// Building system-probe needs kernel headers matched to the target, because the eBPF objects have to
		// match the kernels an operator runs. Datadog precompiles 26 of them; a build runner cannot.
		assert.deepEqual(
			BINARIES.filter((b) => b.from === "release").map((b) => b.shipsAs),
			["system-probe", "process-agent", "security-agent"]
		);
	});

	it("NEGATIVE: every descriptor declares a source, so none defaults into the build path", () => {
		for (const binary of BINARIES)
			assert.ok(
				binary.from === "build" || binary.from === "release",
				`${binary.shipsAs} has no source: ${JSON.stringify(binary.from)}`
			);
	});

	it("the two views partition the binaries for every target, losing none", () => {
		// builtFor drives the build loop and extractedFor will drive extraction. A binary in neither is one
		// that silently stops shipping.
		for (const target of TARGETS) {
			const all = binariesFor(target)
				.map((b) => b.shipsAs)
				.sort();
			const split = [...builtFor(target), ...extractedFor(target)]
				.map((b) => b.shipsAs)
				.sort();
			assert.deepEqual(
				split,
				all,
				`${target.name} loses a binary between the two views`
			);
			assert.equal(
				new Set(split).size,
				split.length,
				`${target.name} has a binary in both views`
			);
		}
	});

	// Linux system-probe is the one that could not be built on a runner: the eBPF objects need a kernel-
	// header tree matched to every kernel an operator might run, which is why Datadog precompiles 26 of
	// them. Off Linux there are no objects to compile, so the same binary is an ordinary Go build.
	it("system-probe is lifted on Linux and built everywhere else", () => {
		const named = (fn, os) =>
			fn(TARGETS.find((t) => t.os === os)).map((b) => b.shipsAs);
		assert.ok(
			named(extractedFor, "linux").includes("system-probe"),
			"Linux builds system-probe, which needs a kernel-header tree per target"
		);
		for (const os of ["macos", "windows"]) {
			assert.ok(
				named(builtFor, os).includes("system-probe"),
				`${os} does not build system-probe, and cannot lift it from a Debian package`
			);
			assert.ok(!named(extractedFor, os).includes("system-probe"));
		}
	});

	// security-agent is lifted on Linux and built on Windows, because the extraction source is a Debian
	// package. A Windows leg that lifted it would refuse the build for an artefact that cannot exist.
	it("security-agent is lifted on Linux and built on Windows", () => {
		const named = (fn, os) =>
			fn(TARGETS.find((t) => t.os === os)).map((b) => b.shipsAs);
		assert.ok(named(extractedFor, "linux").includes("security-agent"));
		assert.ok(named(builtFor, "windows").includes("security-agent"));
		assert.ok(!named(extractedFor, "windows").includes("security-agent"));
	});

	it("macOS extracts nothing, because neither release binary exists there", () => {
		// system-probe is Linux-only and security-agent is Linux and Windows, so the macOS package is
		// wholly built and needs no artefact from Datadog.
		const macos = TARGETS.find((t) => t.os === "macos");
		assert.deepEqual(
			extractedFor(macos).map((b) => b.shipsAs),
			[]
		);
	});

	it("Linux extracts both, which is where the toolchain pain was", () => {
		const linux = TARGETS.find((t) => t.os === "linux");
		assert.deepEqual(
			extractedFor(linux).map((b) => b.shipsAs),
			["system-probe", "process-agent", "security-agent"]
		);
	});
});
