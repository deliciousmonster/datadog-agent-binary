"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	expectedPackages,
	readLocal,
	verify,
	PACKAGE_NAME,
	PACKAGE_VERSION,
} = require("../../scripts/publish-matrix.js");

/** Stage a package dir on disk the way create-platform-packages.js would. */
function stage(dir, platform, { os: pkgOs, cpu, version, binaries }) {
	const packageDir = path.join(dir, platform);
	fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({
			name: `${PACKAGE_NAME}-${platform}`,
			version: version ?? PACKAGE_VERSION,
			os: pkgOs,
			cpu,
		})
	);
	for (const name of binaries) {
		fs.writeFileSync(path.join(packageDir, "bin", name), "x");
	}
}

function withTempDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ddab-matrix-test-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Stage every expected platform correctly, then let the caller break one. */
function stageAll(dir, mutate = () => {}) {
	for (const expected of expectedPackages()) {
		const nodeOs = expected.platform.startsWith("linux")
			? "linux"
			: expected.platform.startsWith("macos")
				? "darwin"
				: "win32";
		const nodeCpu = expected.platform.endsWith("arm64") ? "arm64" : "x64";
		const spec = {
			os: [nodeOs],
			cpu: [nodeCpu],
			binaries: expected.binaries,
		};
		mutate(expected.platform, spec);
		stage(dir, expected.platform, spec);
	}
}

function rowsFor(dir) {
	return expectedPackages().map((e) => readLocal(e, dir));
}

test("a correctly staged matrix has no problems", () => {
	withTempDir((dir) => {
		stageAll(dir);
		assert.deepEqual(verify(rowsFor(dir), { mode: "local" }), []);
	});
});

test("rejects this project's internal os/cpu names (the macos-x86_64 defect)", () => {
	withTempDir((dir) => {
		// Exactly what shipped: our own vocabulary instead of Node's. npm compares these
		// against process.platform/process.arch, so the package could never install, and
		// because the dependency is optional the failure was completely silent.
		stageAll(dir, (platform, spec) => {
			if (platform === "macos-arm64") {
				spec.os = ["macos"];
				spec.cpu = ["x86_64"];
			}
		});
		const problems = verify(rowsFor(dir), { mode: "local" });
		assert.ok(
			problems.some((p) => /os "macos" is not a Node process.platform/.test(p)),
			`expected an os rejection, got: ${problems.join(" | ")}`
		);
		assert.ok(
			problems.some((p) => /cpu "x86_64" is not a Node process.arch/.test(p)),
			`expected a cpu rejection, got: ${problems.join(" | ")}`
		);
	});
});

test("rejects a package missing the trace-agent (the original defect)", () => {
	withTempDir((dir) => {
		stageAll(dir, (platform, spec) => {
			if (platform === "linux-x86_64") {
				// Core agent only, which is precisely what was published: nothing binds
				// 127.0.0.1:8126 and every span is dropped without an error anywhere.
				spec.binaries = spec.binaries.filter(
					(b) => !b.startsWith("trace-agent")
				);
			}
		});
		const problems = verify(rowsFor(dir), { mode: "local" });
		assert.ok(
			problems.some((p) => /missing trace-agent/.test(p)),
			`expected a missing-binary problem, got: ${problems.join(" | ")}`
		);
	});
});

test("rejects a platform package whose version has drifted from the main package", () => {
	withTempDir((dir) => {
		stageAll(dir, (platform, spec) => {
			if (platform === "linux-arm64") spec.version = "0.0.1";
		});
		const problems = verify(rowsFor(dir), { mode: "local" });
		assert.ok(
			problems.some((p) => /does not match the main package/.test(p)),
			`expected a version-skew problem, got: ${problems.join(" | ")}`
		);
	});
});

test("reports a declared platform that was never staged", () => {
	withTempDir((dir) => {
		stageAll(dir);
		// A build leg that failed: the package is declared but absent.
		const victim = expectedPackages()[0].platform;
		fs.rmSync(path.join(dir, victim), { recursive: true, force: true });
		const problems = verify(rowsFor(dir), { mode: "local" });
		assert.ok(
			problems.some((p) => /not found/.test(p) && /skip it silently/.test(p)),
			`expected a not-found problem, got: ${problems.join(" | ")}`
		);
	});
});

// verify() compares optionalDependencies against SUPPORTED_PLATFORMS. A platform
// declared but never built is what made Intel-Mac installs resolve nothing at all,
// silently, because npm skips an unresolvable optional dependency without a warning.
// Asserted both ways: the repo is in sync now, and a drift would actually be caught.
test("optionalDependencies matches SUPPORTED_PLATFORMS, and drift is detected", () => {
	withTempDir((dir) => {
		stageAll(dir);
		const problems = verify(rowsFor(dir), { mode: "local" });
		assert.ok(
			!problems.some((p) => /does not match SUPPORTED_PLATFORMS/.test(p)),
			`optionalDependencies is out of sync: ${problems.join(" | ")}`
		);

		// Stage a platform nobody declares. Without the negative case this test would
		// still pass if the check were deleted from verify() entirely.
		stage(dir, "solaris-sparc", {
			os: ["sunos"],
			cpu: ["sparc"],
			binaries: ["datadog-agent", "trace-agent"],
		});
		const rows = [
			...rowsFor(dir),
			readLocal(
				{
					platform: "solaris-sparc",
					name: `${PACKAGE_NAME}-solaris-sparc`,
					binaries: ["datadog-agent", "trace-agent"],
				},
				dir
			),
		];
		assert.ok(
			verify(rows, { mode: "local" }).some((p) =>
				/does not match SUPPORTED_PLATFORMS/.test(p)
			),
			"an undeclared platform should be reported"
		);
	});
});
