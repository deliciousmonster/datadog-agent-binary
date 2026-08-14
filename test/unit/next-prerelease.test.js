import { test } from 'node:test';
import assert from 'node:assert';

import { nextPrerelease, compare, parseVersion } from '../../scripts/next-prerelease.js';

// The state that shipped a regression: package.json trailed the tags, so a base taken
// from it produced a version below both the stable release and the newest prerelease.
const REAL_TAGS = ['v7.75.4', 'v7.75.5', 'v7.75.6-next.0', 'v7.75.6-next.1'];

test('advances past the highest tag, not the package.json version', () => {
	const { version } = nextPrerelease({
		tags: REAL_TAGS,
		registry: [],
		packageVersion: '7.75.5',
	});
	assert.strictEqual(version, '7.75.6-next.2');
});

test('never goes backwards from an already-released version', () => {
	const { version } = nextPrerelease({
		tags: REAL_TAGS,
		registry: [],
		packageVersion: '7.75.5',
	});
	const highest = parseVersion('7.75.6-next.1', 'next');
	assert.ok(compare(parseVersion(version, 'next'), highest) > 0, `${version} must sort above 7.75.6-next.1`);
});

// A stable release consumes its patch. The next prerelease has to open the following one
// or it sorts below the stable it came after.
test('a stable release pushes the next prerelease onto the next patch', () => {
	const { version } = nextPrerelease({ tags: ['v7.75.5'], registry: [] });
	assert.strictEqual(version, '7.75.6-next.0');
});

test('stable outranks a prerelease of the same triple', () => {
	const { version } = nextPrerelease({
		tags: ['v7.75.5', 'v7.75.5-next.9'],
		registry: [],
	});
	assert.strictEqual(version, '7.75.6-next.0');
});

test('registry and tags are both consulted', () => {
	const fromRegistryOnly = nextPrerelease({
		tags: [],
		registry: ['7.75.6-next.4'],
	});
	assert.strictEqual(fromRegistryOnly.version, '7.75.6-next.5');

	// A tag whose publish failed still burns its number; the registry cannot see it.
	const tagAhead = nextPrerelease({
		tags: ['v7.75.6-next.7'],
		registry: ['7.75.6-next.4'],
	});
	assert.strictEqual(tagAhead.version, '7.75.6-next.8');
});

test('counter comparison is numeric, so 10 beats 9', () => {
	const { version } = nextPrerelease({
		tags: ['v1.0.0-next.9', 'v1.0.0-next.10'],
		registry: [],
	});
	assert.strictEqual(version, '1.0.0-next.11');
});

test('an unpublished scope contributes nothing rather than resetting the count', () => {
	const { version } = nextPrerelease({ tags: REAL_TAGS, registry: [] });
	assert.strictEqual(version, '7.75.6-next.2');
});

test('versions in another channel do not advance this one', () => {
	const { version, ignored } = nextPrerelease({
		channel: 'next',
		tags: ['v7.75.6-next.1', 'v7.75.6-rc.5'],
		registry: [],
	});
	assert.strictEqual(version, '7.75.6-next.2');
	assert.ok(ignored.includes('v7.75.6-rc.5'));
});

test('unparseable versions are reported, not guessed at', () => {
	const { version, ignored } = nextPrerelease({
		tags: ['v7.75.6-next.1', 'v7.75.6-next.beta', 'nightly'],
		registry: [],
	});
	assert.strictEqual(version, '7.75.6-next.2');
	assert.deepStrictEqual(ignored.sort(), ['nightly', 'v7.75.6-next.beta']);
});

test('no known versions bootstraps rather than throwing', () => {
	const { version, highest } = nextPrerelease({ tags: [], registry: [] });
	assert.strictEqual(version, '0.0.0-next.0');
	assert.strictEqual(highest, null);
});

test('a bad channel is rejected', () => {
	assert.throws(() => nextPrerelease({ channel: 'next.1', tags: ['v1.0.0'] }), /lowercase alphanumeric/);
	assert.throws(() => nextPrerelease({ channel: '', tags: ['v1.0.0'] }), /lowercase alphanumeric/);
});

test('a major or minor bump in package.json is still honoured', () => {
	const { version } = nextPrerelease({
		tags: REAL_TAGS,
		registry: [],
		packageVersion: '7.76.0',
	});
	assert.strictEqual(version, '7.76.1-next.0');
});
