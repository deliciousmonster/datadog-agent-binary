/**
 * One owner for the spawn name. AgentBinaryDescriptor.processName is documented as the sole
 * source of Harper's `spawn` `name`, which is also the PID-lock filename
 * (`<rootPath>/pids/<name>.pid`). The example used to restate both strings, so changing the
 * descriptor moved the launcher's lock and left the example's where it was: two spellings,
 * two locks, two core agents per node with neither able to see the other.
 *
 * Asserted against the source text rather than the module. Importing dd-supervisor.js runs a
 * component that expects Harper's globals, and the invariant here is about what the file
 * says, not what it computes: a restated literal is the defect, whether or not it currently
 * agrees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, importDist } from '../support/harness.js';

const { Platform } = await importDist('platform.js');

const SUPERVISOR = path.join(REPO_ROOT, 'example', 'dd-supervisor.js');
const source = fs.readFileSync(SUPERVISOR, 'utf8');

/** Every name the descriptors own, on this host's platform. */
const OWNED = Platform.current()
	.getBinaries()
	.map((binary) => binary.processName);

test('the descriptors name both agents, and the two differ', () => {
	assert.equal(OWNED.length, 2, 'a kind was added or dropped without updating this test');
	assert.equal(new Set(OWNED).size, 2, 'both agents would take the same PID lock, so one would never start');
});

test('the example does not restate a name the descriptors own', () => {
	for (const name of OWNED) {
		// Quoted and whole: `datadog-agent-reaper` contains `datadog-agent`, and the reaper is
		// the example's own process, correctly named here.
		for (const quote of ["'", '"', '`']) {
			assert.ok(
				!source.includes(`${quote}${name}${quote}`),
				`example/dd-supervisor.js hardcodes ${quote}${name}${quote}. Read it from the ` +
					`descriptor (namedAgents()) instead: a second copy drifts, and the two spellings ` +
					`take different PID locks.`
			);
		}
	}
});

test('the example reads the name from the descriptor', () => {
	assert.match(
		source,
		/platform\.getBinary\(\s*agent\.kind\s*\)\.processName/,
		'namedAgents() is how the example gets its spawn names; if it moved, this guard is checking nothing'
	);
});

test('the reaper keeps its own name, which no descriptor owns', () => {
	// Deliberately a literal: it is not a Datadog binary, so nothing upstream owns it, and it
	// needs a lock distinct from both agents'.
	assert.match(source, /name: 'datadog-agent-reaper'/);
	assert.ok(!OWNED.includes('datadog-agent-reaper'), 'the reaper would collide with an agent lock');
});
