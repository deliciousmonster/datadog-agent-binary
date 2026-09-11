// The smoke test asks each binary for its version, and two of them need a config to answer at all.
//
// CI on 2026-09-11 failed three legs on `security-agent: unable to load Datadog config file`, and the
// cause was not the flag. checkReportsVersion took an extraArgs parameter, both call sites passed one,
// and the spawn built `["version"]` and threw the parameter away. process-agent hid it by answering
// bare. Nothing tested the script, so the only thing that could catch it was a full build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHECKS, versionArgv } from "../../scripts/smoke-test-binaries.js";

const RUNTIME_DIR = "/runtime/datadog-agent-binary";

test("the version argv carries the extra arguments it was given", () => {
	assert.deepEqual(versionArgv(["--cfgpath", RUNTIME_DIR]), [
		"version",
		"--cfgpath",
		RUNTIME_DIR,
	]);
});

// The defect exactly: a builder that answers "version" whatever it is handed passes a naive test and
// fails every agent that needs a config.
test("NEGATIVE: the extra arguments are not dropped", () => {
	const built = versionArgv(["--cfgpath", RUNTIME_DIR]);
	assert.notDeepEqual(built, ["version"], "extraArgs went nowhere");
	assert.equal(built.length, 3);
});

test("no extra arguments leaves the bare version call the other binaries answer", () => {
	assert.deepEqual(versionArgv(), ["version"]);
	assert.deepEqual(versionArgv([]), ["version"]);
});

// security-agent is the one that cannot answer bare, so its check has to be the one carrying a config.
test("security-agent and process-agent are both checked with a config directory", () => {
	for (const name of ["security-agent", "process-agent"]) {
		assert.equal(
			typeof CHECKS[name],
			"function",
			`${name} has no registered check`
		);
		const source = CHECKS[name].toString();
		assert.ok(
			source.includes("--cfgpath"),
			`${name}'s check does not pass a config path`
		);
		assert.ok(
			source.includes("runtimeDir"),
			`${name}'s check passes a config path that is not the runtime directory`
		);
	}
});

test("system-probe is checked bare, because it loads no config to print a version", () => {
	assert.equal(typeof CHECKS["system-probe"], "function");
	assert.ok(!CHECKS["system-probe"].toString().includes("--cfgpath"));
});
