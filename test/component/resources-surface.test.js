// resources.js is the file a reader opens first, and the only one Harper compiles. It declares which
// binaries ship and hands down the two things only it can see; everything else belongs behind the factory.
//
// This exists because that file was 535 lines. It held port parsing, probe status, the status resource, a
// metrics timer and the whole start path, so the question "what does this plugin run?" took a scroll to
// answer. The line budget below is not style: it is what stops the same accretion happening again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { KNOWN, agentsFor } from "../../runtime/datadog.js";
import { loadComponent } from "../support/component.js";

const source = readFileSync(
	new URL("../../resources.js", import.meta.url),
	"utf8"
);
const code = source
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith("//"));

test("resources.js is small enough to read at a glance", () => {
	assert.ok(
		code.length <= 25,
		`resources.js is ${code.length} lines of code; it declares the binaries and nothing else, so anything past ~25 belongs in runtime/`
	);
});

// The specific things that used to live here and must not come back. Each one is a reason the file grew.
test("NEGATIVE: no logic followed the declarations back into resources.js", () => {
	for (const forbidden of [
		"process.env",
		"setTimeout",
		"function ",
		"class ",
		"try {",
		"await ",
	])
		assert.ok(
			!source.includes(forbidden),
			`resources.js contains ${JSON.stringify(forbidden)}; it declares, it does not compute`
		);
});

test("every binary the component starts is named in resources.js", async () => {
	const { AGENTS } = await loadComponent();
	for (const agent of AGENTS)
		assert.ok(
			source.includes(`"${agent.shipsAs}"`),
			`${agent.shipsAs} starts but is not named in resources.js`
		);
	assert.equal(AGENTS.length, 5);
});

// A list is the whole declaration, so a typo in it is a binary that silently never starts. That is the
// failure mode this package exists to remove, and it would be absurd to reintroduce it in the file that
// declares them.
test("NEGATIVE: an unknown process name throws and names the alternatives", () => {
	assert.throws(
		() => agentsFor(["trace_agent"], { receiver: 8126 }),
		(error) => {
			assert.match(error.message, /unknown Datadog process "trace_agent"/);
			for (const known of KNOWN)
				assert.ok(
					error.message.includes(known),
					`the refusal does not offer ${known}`
				);
			return true;
		}
	);
});

test("the declared order is the start order, and the trace-agent is first", async () => {
	const { AGENTS } = await loadComponent();
	assert.equal(
		AGENTS[0].shipsAs,
		"trace-agent",
		"the trace-agent owns the socket dd-trace dials, so it starts first"
	);
	// agentsFor preserves the caller's order rather than the table's, which is what makes the list above
	// the statement of start order rather than a set.
	const reversed = agentsFor(["datadog-agent", "trace-agent"], { receiver: 0 });
	assert.deepEqual(
		reversed.map((a) => a.shipsAs),
		["datadog-agent", "trace-agent"]
	);
});

// The lock name and the binary name differ for four of the five, and a second spelling is a second lock.
test("each declared binary maps to exactly one spawn name", () => {
	const agents = agentsFor(KNOWN, { receiver: 8126 });
	const names = agents.map((a) => a.name);
	assert.equal(
		new Set(names).size,
		names.length,
		"two agents share a lock name"
	);
	assert.deepEqual(
		agents.map((a) => `${a.shipsAs} -> ${a.name}`),
		[
			"trace-agent -> datadog-trace-agent",
			"datadog-agent -> datadog-agent",
			"system-probe -> datadog-system-probe",
			"process-agent -> datadog-process-agent",
			"security-agent -> datadog-security-agent",
		]
	);
});
