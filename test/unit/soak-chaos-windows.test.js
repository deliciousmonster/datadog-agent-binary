// A structural guard on the soak harness's disruption bookkeeping.
//
// Four separate failures in one week came from the same habit: the node being disrupted without the
// harness recording that it was, so requests the node was never expected to serve were charged against
// it. Two were actions that claimed no window; one was a plain assignment shortening a window another
// caller had already taken; one was the evaluator re-deriving quietness from a minute count that
// disagreed with the window actually claimed. None was a Harper defect.
//
// soak.mjs is a script rather than a module, so these assertions read its source. That is deliberate: the
// invariants are about how the file is written, and they are the cheapest way to stop the habit returning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
	fileURLToPath(new URL("../soak/soak.mjs", import.meta.url)),
	"utf-8"
);

test("only claimWindow writes chaos.busyUntil", () => {
	const writes = [...source.matchAll(/chaos\.busyUntil\s*=/g)];
	assert.equal(
		writes.length,
		1,
		"a second writer is how a shorter window came to undo a longer one; extend through claimWindow instead"
	);
	// and that one write is the extending kind, not an assignment
	assert.match(
		source,
		/chaos\.busyUntil = Math\.max\(chaos\.busyUntil,/,
		"claimWindow must extend the window, never replace it"
	);
});

test("every chaos action is covered by a floor claimed before it runs", () => {
	// fireChaos claims before dispatching, so an action that forgets is no longer a way to get this wrong
	const fire = source.slice(source.indexOf("async function fireChaos"));
	const claim = fire.indexOf("claimWindow(");
	const dispatch = fire.indexOf("await ACTIONS[name]()");
	assert.ok(claim > -1, "fireChaos must claim a window");
	assert.ok(
		claim < dispatch,
		"the floor has to be claimed before the action runs, or the action's own disruption escapes it"
	);
});

test("the status row records the harness's own busy state", () => {
	assert.match(
		source,
		/chaos\.busyUntil > Date\.now\(\) \? " busy" : ""/,
		"the evaluator reads this marker instead of re-deriving quietness from elapsed minutes"
	);
});

test("restarting the node claims a window wherever it is called from", () => {
	const restart = source.slice(
		source.indexOf("const restartNode"),
		source.indexOf("const claimWindow")
	);
	const returns = [...restart.matchAll(/claimRestartWindow\(\)/g)];
	assert.equal(
		returns.length,
		2,
		"both the container and host paths must claim; one of them not doing so was the second failure"
	);
});
