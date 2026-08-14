#!/usr/bin/env node

// Computes the next prerelease version, strictly above everything already released.
//
// The inputs are the git tags and the registry, never package.json alone. package.json
// carries whatever the last release set and is not advanced by the pipeline
// (build-release.yml runs `npm version --no-git-tag-version` on a throwaway checkout and
// commits nothing), so deriving the base from it walks backwards the moment a release
// moves the minor: at 7.75.5 with v7.75.6-next.1 already tagged it yields 7.75.5-next.0,
// which sorts below both.
//
// Only two shapes are understood, `X.Y.Z` and `X.Y.Z-<channel>.N`. Anything else is
// ignored rather than guessed at, and the caller is told what was skipped.

import { isCliEntry } from './cli-entry.js';

const CHANNEL_RE = /^[a-z][a-z0-9]*$/;

export function parseVersion(raw, channel) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(raw).replace(/^v/, ''));
	if (!m) return null;
	const [, maj, min, pat, pre] = m;
	if (pre === undefined) {
		return { maj: +maj, min: +min, pat: +pat, pre: null, raw };
	}
	const p = new RegExp(`^${channel}\\.(\\d+)$`).exec(pre);
	if (!p) return null;
	return { maj: +maj, min: +min, pat: +pat, pre: +p[1], raw };
}

// Stable outranks a prerelease of the same triple, which is what makes 7.75.5 beat
// 7.75.5-next.9 and forces the next prerelease onto a new patch.
export function compare(a, b) {
	if (a.maj !== b.maj) return a.maj - b.maj;
	if (a.min !== b.min) return a.min - b.min;
	if (a.pat !== b.pat) return a.pat - b.pat;
	if (a.pre === null && b.pre === null) return 0;
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	return a.pre - b.pre;
}

function format(v, channel) {
	const base = `${v.maj}.${v.min}.${v.pat}`;
	return v.pre === null ? base : `${base}-${channel}.${v.pre}`;
}

/**
 * @returns {{version: string, highest: string|null, ignored: string[]}}
 * @throws if the computed version does not sort strictly above every known version.
 */
export function nextPrerelease({ channel = 'next', tags = [], registry = [], packageVersion = null } = {}) {
	if (!CHANNEL_RE.test(channel)) {
		throw new Error(`Channel must be lowercase alphanumeric, got "${channel}".`);
	}

	const candidates = [...tags, ...registry, ...(packageVersion ? [packageVersion] : [])];
	const ignored = [];
	const known = [];
	for (const c of candidates) {
		const parsed = parseVersion(c, channel);
		if (parsed) known.push(parsed);
		else ignored.push(String(c));
	}

	// Nothing recognisable anywhere is the bootstrap case, not an error.
	if (known.length === 0) {
		return { version: `0.0.0-${channel}.0`, highest: null, ignored };
	}

	const highest = known.reduce((a, b) => (compare(a, b) >= 0 ? a : b));

	// A prerelease advances its counter. A stable release has already consumed its
	// patch, so the next prerelease has to open the following one.
	const next =
		highest.pre === null
			? { maj: highest.maj, min: highest.min, pat: highest.pat + 1, pre: 0 }
			: { ...highest, pre: highest.pre + 1 };

	if (compare(next, highest) <= 0) {
		throw new Error(`Computed ${format(next, channel)} does not sort above ${format(highest, channel)}.`);
	}

	return {
		version: format(next, channel),
		highest: format(highest, channel),
		ignored,
	};
}

if (isCliEntry(import.meta.url)) {
	const args = process.argv.slice(2);
	const get = (flag) => {
		const i = args.indexOf(flag);
		return i === -1 ? null : args[i + 1];
	};
	const split = (s) => (s ? s.split(/[\s,]+/).filter(Boolean) : []);

	let registry = [];
	try {
		const parsed = JSON.parse(get('--registry') ?? 'null');
		// An unpublished scope answers with a well-formed `{"error":{...}}` body, so
		// valid JSON is not the same as a version list. Keep only the strings.
		registry = (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => typeof v === 'string');
	} catch {
		// Not JSON at all, so nothing published is known. Tags still decide.
	}

	try {
		const result = nextPrerelease({
			channel: get('--channel') || 'next',
			tags: split(get('--tags')),
			registry,
			packageVersion: get('--package-version'),
		});
		if (result.ignored.length) console.error(`Ignored unparseable versions: ${result.ignored.join(', ')}`);
		console.error(`Highest known: ${result.highest ?? 'none'}`);
		process.stdout.write(result.version);
	} catch (err) {
		console.error(`::error::${err.message}`);
		process.exit(1);
	}
}
