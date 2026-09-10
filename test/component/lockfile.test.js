// The lock file has to agree with the manifest, because `npm ci` is the first thing every CI leg runs.
//
// This is not a theoretical tidiness check. On 2026-09-10 all four build legs failed at `npm ci` with
// EUSAGE, and the reason was four entries reading `{"optional": true}` and nothing else: no version, no
// integrity. npm cannot confirm an entry with no version satisfies a range, so it refuses the whole
// install. The lock was written when those packages did not yet exist on the registry, which is the
// ordinary state during the run that first publishes them, and it stayed that way through every commit
// after. Nothing failed until a runner's npm grew strict about it, and then everything failed at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) =>
	JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));

const manifest = read("package.json");
const lock = read("package-lock.json");

test("every dependency the manifest declares is resolved in the lock", () => {
	const declared = {
		...(manifest.dependencies ?? {}),
		...(manifest.devDependencies ?? {}),
		...(manifest.optionalDependencies ?? {}),
	};
	const unresolved = [];
	for (const name of Object.keys(declared)) {
		const entry = lock.packages?.[`node_modules/${name}`];
		if (!entry) unresolved.push(`${name}: no entry in the lock at all`);
		else if (!entry.version)
			unresolved.push(
				`${name}: an entry carrying ${JSON.stringify(entry)} and no version, which npm ci refuses`
			);
	}
	assert.deepEqual(
		unresolved,
		[],
		"npm ci will fail on every CI leg; run `npm install --package-lock-only` with these published"
	);
});

// An optionalDependency is the case that produced the failure, and it is the one most likely to recur:
// a platform package is unresolvable at exactly the moment the run that publishes it writes the lock.
test("NEGATIVE: an optionalDependency is not exempt from carrying a version", () => {
	const optional = Object.keys(manifest.optionalDependencies ?? {});
	assert.ok(
		optional.length > 0,
		"no optionalDependencies; this check is blind"
	);
	for (const name of optional) {
		const entry = lock.packages?.[`node_modules/${name}`];
		assert.ok(entry?.version, `${name} is in the lock with no version`);
		assert.ok(
			entry.integrity,
			`${name} has a version and no integrity, so nothing pins what gets installed`
		);
	}
});

// The versions have to match too, not merely exist. A lock pinning an older platform package than the
// manifest asks for installs binaries from a different release than the component was built against.
test("the lock pins each platform package at the version the manifest asks for", () => {
	for (const [name, range] of Object.entries(
		manifest.optionalDependencies ?? {}
	)) {
		const entry = lock.packages?.[`node_modules/${name}`];
		assert.equal(
			entry?.version,
			range,
			`${name}: the manifest asks ${range} and the lock pins ${entry?.version}`
		);
	}
});

// The root entry is the manifest's own copy inside the lock, and npm compares them directly.
test("the lock's root version is the manifest's version", () => {
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages?.[""]?.version, manifest.version);
});

// os/cpu are what make an optionalDependency skip on the wrong host. A platform package resolved in the
// lock without them installs everywhere, and four agents' worth of binaries land on every install.
test("each platform package is host-matched in the lock, not just in its own manifest", () => {
	for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
		const entry = lock.packages?.[`node_modules/${name}`];
		assert.ok(
			Array.isArray(entry?.os) && entry.os.length > 0,
			`${name} carries no os in the lock, so npm installs it on every host`
		);
		assert.ok(Array.isArray(entry?.cpu) && entry.cpu.length > 0);
	}
});
