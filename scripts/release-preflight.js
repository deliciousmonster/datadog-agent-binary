#!/usr/bin/env node

/**
 * Fail the release path in seconds instead of after every platform's Go build.
 *
 * Two failures only surface at `npm publish`, which runs last: ENEEDAUTH on a
 * name Trusted Publishing cannot mint a token for (OIDC cannot bootstrap a
 * never-published name, and platform packages publish first), and a provenance
 * rejection when repository.url does not match the building repo. Either one
 * burns the version number after the full build.
 *
 * Called from prerelease.yml before the tag is cut, and again from a preflight
 * job in build-release.yml, because a hand-pushed tag never passes through
 * prerelease.yml.
 *
 * What this cannot prove: that a trusted publisher is configured for this repo
 * and workflow (npm exposes no read API), or that a live token has publish
 * rights on the scope (npm has no permission probe). Those residues still fail
 * at publish; everything checkable earlier is checked here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY = 'https://registry.npmjs.org';

/** The five names the publish loop will hit: platform packages first, then main. */
function packageNames(pkg) {
	return [...Object.keys(pkg.optionalDependencies || {}), pkg.name];
}

/**
 * npm normalizes every form below via hosted-git-info before the provenance
 * check, so all of them must be recognized or a legal manifest is blocked.
 * Returns lowercase "owner/name", or null when no GitHub repo is declared.
 */
function normalizeRepoSlug(repository) {
	const url = typeof repository === 'string' ? repository : repository && repository.url;
	if (!url) return null;
	const m = String(url)
		.trim()
		.match(
			/^(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|github:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i
		);
	return m ? m[1].toLowerCase() : null;
}

/**
 * `npm view` exits 1 for both "never published" and "registry unreachable".
 * Only the first means OIDC cannot work; the second must retry, not report a
 * virgin package and tell the operator to re-add the token they just deleted.
 */
function classifyNpmFailure(stderr) {
	return /E404|404 Not Found/i.test(String(stderr)) ? 'not-published' : 'transient';
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npmExec(args, opts = {}) {
	return execFileSync('npm', args, {
		encoding: 'utf8',
		stdio: 'pipe',
		...opts,
	});
}

/** true / false / throws after retries when the registry cannot answer. */
function isPublished(name, exec = npmExec) {
	for (let attempt = 1; ; attempt++) {
		try {
			exec(['view', name, 'version', '--registry', REGISTRY]);
			return true;
		} catch (error) {
			if (classifyNpmFailure(error.stderr) === 'not-published') return false;
			if (attempt >= 3) {
				throw new Error(
					`registry unreachable while checking ${name}: ${String(error.stderr || error.message)
						.trim()
						.slice(0, 200)}`
				);
			}
			sleep(attempt * 2000);
		}
	}
}

/** A token that whoami rejects would 401 after the build; catch it now. */
function verifyToken(token, exec = npmExec) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-npmrc-'));
	const rc = path.join(dir, 'npmrc');
	fs.writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\n`, {
		mode: 0o600,
	});
	try {
		for (let attempt = 1; ; attempt++) {
			try {
				const user = exec(['whoami', '--userconfig', rc, '--registry', REGISTRY]).trim();
				return { ok: true, user };
			} catch (error) {
				if (/E401|ENEEDAUTH|Unauthorized/i.test(String(error.stderr))) {
					return {
						ok: false,
						reason:
							'NPM_TOKEN is set but the registry rejects it (revoked or expired). The publish would 401 after the full build.',
					};
				}
				if (attempt >= 3) {
					return {
						ok: false,
						reason: `registry unreachable while verifying NPM_TOKEN: ${String(error.stderr || error.message)
							.trim()
							.slice(0, 200)}`,
					};
				}
				sleep(attempt * 2000);
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function checkRepositoryMatch(pkg, githubRepository) {
	if (!githubRepository) {
		return { ok: true, note: 'GITHUB_REPOSITORY unset; skipping (local run).' };
	}
	const slug = normalizeRepoSlug(pkg.repository);
	const expected = githubRepository.toLowerCase();
	if (slug === expected) return { ok: true };
	return {
		ok: false,
		reason:
			`repository.url resolves to "${slug}" but the build runs in "${githubRepository}". ` +
			'npm publish --provenance verifies this per package after the full build. ' +
			'Platform manifests inherit the root repository field, so fix package.json.',
	};
}

function checkAuthPath(pkg, token, exec = npmExec) {
	if (token) {
		const verdict = verifyToken(token, exec);
		if (!verdict.ok) return { ok: false, reason: verdict.reason };
		return {
			ok: true,
			note: `NPM_TOKEN is live (npm whoami: ${verdict.user}).`,
		};
	}
	const virgin = packageNames(pkg).filter((name) => !isPublished(name, exec));
	if (virgin.length > 0) {
		return {
			ok: false,
			reason:
				`no NPM_TOKEN, and Trusted Publishing cannot bootstrap never-published names: ${virgin.join(', ')}. ` +
				'The publish loop would die ENEEDAUTH after the full build. Set NPM_TOKEN for the first publish of each new name.',
		};
	}
	return {
		ok: true,
		note:
			'No NPM_TOKEN; every package name is already published, so Trusted Publishing is possible. ' +
			'Whether a publisher is configured for this repo and workflow is not checkable from here.',
	};
}

function main() {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
	const results = [
		checkRepositoryMatch(pkg, process.env.GITHUB_REPOSITORY),
		checkAuthPath(pkg, (process.env.NPM_TOKEN || '').trim()),
	];
	let failed = false;
	for (const result of results) {
		if (result.ok) {
			if (result.note) console.log(result.note);
		} else {
			failed = true;
			console.error(`::error::${result.reason}`);
		}
	}
	if (failed) process.exit(1);
	console.log('Preflight OK: the publish path is as ready as it can be proven.');
}

if (require.main === module) main();

module.exports = {
	packageNames,
	normalizeRepoSlug,
	classifyNpmFailure,
	checkRepositoryMatch,
	checkAuthPath,
	isPublished,
};
