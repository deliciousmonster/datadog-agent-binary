// Two readings that sent people looking in the wrong place: "failed to execute", which names none of the
// three causes a refused spawn has, and exit code 0 for a child the kernel killed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeExit, describeSpawnFailure } from "../../agent-exit.js";

const errnoError = (code) => Object.assign(new Error("spawn EAGAIN"), { code });

test("a refused spawn is reported by cause, not as one sentence for all three", () => {
	const binary = "/opt/agents/trace-agent";

	assert.match(
		describeSpawnFailure(errnoError("ENOEXEC"), binary),
		/ENOEXEC.*another architecture/s,
		"a binary built for the wrong architecture passes X_OK, so nothing but this line names it"
	);
	assert.match(
		describeSpawnFailure(errnoError("EACCES"), binary),
		/EACCES.*noexec/s,
		"a permission failure has three places to look and the message must name them"
	);
	assert.match(
		describeSpawnFailure(errnoError("ENOENT"), binary),
		/ENOENT/,
		"a resolved path with nothing at it means the platform package installed without its binary"
	);
	// Harper's own spawn refusal carries its remedy in the message, so it must survive intact.
	assert.equal(
		describeSpawnFailure(
			new Error("/opt/agents/trace-agent is not allowed"),
			binary
		),
		"/opt/agents/trace-agent is not allowed",
		"an error with no errno must keep the text it came with"
	);
});

test("NEGATIVE: an OOM-killed agent does not read as a clean stop", () => {
	const killed = describeExit(null, "SIGKILL");
	assert.equal(killed.killed, true);
	assert.match(killed.detail, /OOM kill/);
	assert.notEqual(
		killed.exitCode,
		0,
		"SIGKILL reports no exit code, so every `code || 0` reads an OOM kill as success"
	);

	const stopped = describeExit(null, "SIGTERM");
	assert.equal(
		stopped.killed,
		false,
		"SIGTERM is a supervisor shutting the agent down, not a crash"
	);

	assert.deepEqual(describeExit(0, null), {
		killed: false,
		detail: "exited cleanly",
		exitCode: 0,
	});
	assert.equal(describeExit(2, null).exitCode, 2);
});
