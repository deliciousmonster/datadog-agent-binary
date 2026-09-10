// What the resolver says when nothing resolved.
//
// Three states produce the same symptom, a missing binary, and want different things from whoever reads
// the log. The probe package's absence is the common one and is not a fault at all: it is opt-in, so the
// message has to say so and name the install, or an operator reads "no system-probe binary" as a broken
// package and goes looking for the bug.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PACKAGE_NAME, resolutionFailure } from "../../runtime/binary.js";

const BASE = `${PACKAGE_NAME}-linux-arm64`;
const PROBE = `${PACKAGE_NAME}-probe-linux-arm64`;
const LOCAL = "/app/build/linux-arm64/bin/system-probe";

const asked = (base, probe) => [
	{ name: BASE, optional: false, ...base },
	{ name: PROBE, optional: true, ...probe },
];

test("an uninstalled probe package reads as opt-in, and names the install", () => {
	const message = resolutionFailure(
		asked({ installed: true }, { installed: false }),
		"system-probe",
		LOCAL
	);
	assert.match(message, /is not installed/);
	assert.match(message, new RegExp(`npm install ${PROBE}`));
	assert.doesNotMatch(
		message,
		/predates/,
		"blamed a stale version for a package that is simply not there"
	);
});

// The base package being absent is a broken install, not a choice, so it must not borrow the probe
// package's "install it when you want it" wording.
test("an absent base package does not read as an opt-in the operator declined", () => {
	const message = resolutionFailure(
		asked({ installed: false }, { installed: false }),
		"trace-agent",
		LOCAL
	);
	assert.doesNotMatch(message, /npm install/);
	assert.match(message, new RegExp(BASE));
	assert.match(message, new RegExp(PROBE));
	assert.match(message, /local build/);
});

// The defect this package was built to fix: a platform package published before the trace-agent existed
// answers every request with the core agent. Resolving it starts two core agents and no receiver, so the
// wrong-file case has to be reported as a version to upgrade rather than a package to install.
test("a package answering with the wrong file reads as a version to upgrade", () => {
	const message = resolutionFailure(
		asked(
			{ installed: true, staleMatch: "/n/m/pkg/bin/datadog-agent" },
			{ installed: false }
		),
		"trace-agent",
		LOCAL
	);
	assert.match(message, /predates trace-agent support/);
	assert.match(message, /datadog-agent/);
	assert.doesNotMatch(
		message,
		/npm install/,
		"told the reader to install a package that is already installed"
	);
});

// A wrong answer outranks an absence: an operator who installs the probe package on this advice still has
// the same broken base package afterwards, and has learnt nothing.
test("a wrong answer is reported ahead of an uninstalled optional package", () => {
	const message = resolutionFailure(
		asked(
			{ installed: true, staleMatch: "/n/m/pkg/bin/datadog-agent" },
			{ installed: false }
		),
		"system-probe",
		LOCAL
	);
	assert.match(message, /predates/);
});

// The whole point of asking both is that the fallback names both. A message naming one leaves the reader
// checking the package that was fine.
test("with nothing else to say, the message names every package that was asked", () => {
	const message = resolutionFailure(
		asked({ installed: true }, { installed: true }),
		"system-probe",
		LOCAL
	);
	assert.match(message, new RegExp(BASE));
	assert.match(message, new RegExp(PROBE));
	assert.match(message, new RegExp(LOCAL.replace(/\//g, "\\/")));
});

// An installed probe package that carries nothing useful is not an opt-in to suggest: suggesting an
// install of something already installed is advice that cannot work.
test("an installed probe package is never suggested for installation", () => {
	const message = resolutionFailure(
		asked({ installed: true }, { installed: true }),
		"security-agent",
		LOCAL
	);
	assert.doesNotMatch(message, /npm install/);
});
