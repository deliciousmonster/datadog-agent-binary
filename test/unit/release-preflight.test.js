const { test } = require('node:test');
const assert = require('node:assert');

const {
	packageNames,
	normalizeRepoSlug,
	classifyNpmFailure,
	checkRepositoryMatch,
	checkAuthPath,
	isPublished,
} = require('../../scripts/release-preflight.js');

const PKG = {
	name: '@deliciousmonster/datadog-agent-binary',
	repository: {
		type: 'git',
		url: 'git+https://github.com/HarperFast/datadog-agent-binary.git',
	},
	optionalDependencies: {
		'@deliciousmonster/datadog-agent-binary-linux-x86_64': '7.75.5',
		'@deliciousmonster/datadog-agent-binary-linux-arm64': '7.75.5',
	},
};

/** Fake npm: publishedNames answer, everything else throws with the given stderr. */
function fakeExec({ published = [], stderr = 'npm error code E404' } = {}) {
	return (args) => {
		if (args[0] === 'view') {
			if (published.includes(args[1])) return '7.75.5\n';
			const error = new Error('npm view failed');
			error.stderr = stderr;
			throw error;
		}
		throw new Error(`unexpected npm ${args[0]}`);
	};
}

test("the publish loop's order is platform packages first, main last", () => {
	assert.deepStrictEqual(packageNames(PKG), [
		'@deliciousmonster/datadog-agent-binary-linux-x86_64',
		'@deliciousmonster/datadog-agent-binary-linux-arm64',
		'@deliciousmonster/datadog-agent-binary',
	]);
});

// npm accepts every one of these via hosted-git-info; rejecting any would block
// a manifest the downstream provenance check is fine with.
test('every npm-legal GitHub form normalizes to the same slug', () => {
	const forms = [
		'git+https://github.com/Owner/Repo.git',
		'https://github.com/Owner/Repo',
		'https://github.com/Owner/Repo/',
		'git@github.com:Owner/Repo.git',
		'ssh://git@github.com/Owner/Repo.git',
		'git://github.com/Owner/Repo.git',
		'github:Owner/Repo',
	];
	for (const url of forms) {
		assert.strictEqual(normalizeRepoSlug(url), 'owner/repo', url);
		assert.strictEqual(normalizeRepoSlug({ type: 'git', url }), 'owner/repo');
	}
});

test('a missing or non-GitHub repository yields null, not a crash', () => {
	assert.strictEqual(normalizeRepoSlug(undefined), null);
	assert.strictEqual(normalizeRepoSlug({}), null);
	assert.strictEqual(normalizeRepoSlug('https://gitlab.com/owner/repo'), null);
});

// The original gate used a substring test, so "owner/repo" matched a URL for
// "owner/repo-extended" and provenance rejected it after the full build.
test('a sibling repo whose name extends this one does not match', () => {
	const result = checkRepositoryMatch(
		{ repository: 'https://github.com/HarperFast/datadog-agent-binary-fork' },
		'HarperFast/datadog-agent-binary'
	);
	assert.strictEqual(result.ok, false);
});

test('match is case-insensitive and .git-insensitive', () => {
	const result = checkRepositoryMatch(PKG, 'harperfast/DATADOG-AGENT-BINARY');
	assert.strictEqual(result.ok, true);
});

test('a mismatched repo fails with the manifest named in the reason', () => {
	const result = checkRepositoryMatch(PKG, 'deliciousmonster/datadog-agent-binary');
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /package\.json/);
});

test('outside CI the repository check skips instead of guessing', () => {
	assert.strictEqual(checkRepositoryMatch(PKG, undefined).ok, true);
	assert.strictEqual(checkRepositoryMatch(PKG, '').ok, true);
});

test('E404 means never published; anything else is transient', () => {
	assert.strictEqual(classifyNpmFailure('npm error code E404'), 'not-published');
	assert.strictEqual(classifyNpmFailure('npm error 404 Not Found'), 'not-published');
	assert.strictEqual(classifyNpmFailure('npm error network ECONNRESET'), 'transient');
	assert.strictEqual(classifyNpmFailure('npm error code E500'), 'transient');
	assert.strictEqual(classifyNpmFailure(''), 'transient');
});

test('a registry outage throws after retries rather than reporting a virgin package', () => {
	let calls = 0;
	const exec = () => {
		calls++;
		const error = new Error('down');
		error.stderr = 'npm error network ETIMEDOUT';
		throw error;
	};
	assert.throws(() => isPublished('@scope/pkg', exec), /registry unreachable/);
	assert.strictEqual(calls, 3);
});

test('without a token, one virgin name among five fails the gate and is named', () => {
	const published = ['@deliciousmonster/datadog-agent-binary-linux-x86_64', '@deliciousmonster/datadog-agent-binary'];
	const result = checkAuthPath(PKG, '', fakeExec({ published }));
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /linux-arm64/);
	assert.doesNotMatch(result.reason, /linux-x86_64,/);
});

test('without a token, all names published passes with the unprovable residue stated', () => {
	const result = checkAuthPath(PKG, '', fakeExec({ published: packageNames(PKG) }));
	assert.strictEqual(result.ok, true);
	assert.match(result.note, /not checkable/);
});
