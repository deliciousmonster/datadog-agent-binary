/**
 * The documented node config filename.
 *
 * `harper install` writes `harper-config.yaml` and pins its absolute path in
 * `~/.harperdb/hdb_boot_properties.file`; `harperdb-config.yaml` is the legacy name from the
 * old `harperdb` package, probed only under ROOTPATH with no boot file. Harper parses exactly
 * one config file and never merges two, so a `harperdb-config.yaml` created beside an
 * installed node's config is a file nothing opens.
 *
 * The docs told the reader to create exactly that file. Following them left the allowlist,
 * both `threads` keys and the log level unread, and the only symptom was
 * `Command /... is not allowed`, which the troubleshooting table blamed on a missing restart.
 * These cases exist because the failure is silent: no warning, no second config, nothing in
 * hdb.log naming the file that was skipped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../support/harness.js';

const LEGACY = 'harperdb-config.yaml';
const CURRENT = 'harper-config.yaml';

/** Files a reader follows to configure a node, plus the maintainer notes behind them. */
const DOCUMENTS = [
	'example/README.md',
	'example/harper-config.example.yaml',
	'example/resources.js',
	'README.md',
	'AGENTS.md',
].map((relative) => ({ relative, body: fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8') }));

/**
 * The document split into the smallest units that carry a complete claim: one table row, or
 * one blank-line-delimited paragraph. Prose wraps, so a line is too small a window - the
 * sentence saying "legacy" routinely lands on the line after the one naming the file - and
 * the whole document is far too large a one.
 */
function claimUnits(body) {
	const units = [];
	let paragraph = null;
	body.split('\n').forEach((line, index) => {
		const number = index + 1;
		// A table row stands alone: the rows around it make unrelated claims, and folding a
		// table into one unit would let any row's caveat excuse every other row.
		if (line.startsWith('|')) {
			paragraph = null;
			units.push({ number, text: line });
			return;
		}
		if (line.trim() === '') {
			paragraph = null;
			return;
		}
		if (!paragraph) {
			paragraph = { number, text: line };
			units.push(paragraph);
			return;
		}
		paragraph.text += `\n${line}`;
	});
	return units;
}

/**
 * Units mentioning the legacy name, with `harper-config.yaml` masked out first: the current
 * name ends in the legacy one as a substring, so a naive `includes` matches every correct
 * mention too.
 */
function legacyMentions(body) {
	return claimUnits(body).filter((unit) => unit.text.replaceAll(CURRENT, '\0').includes(LEGACY));
}

/**
 * Whether a unit naming the legacy file marks it as legacy. A mention that does not is an
 * instruction to use it, which is the defect.
 */
function marksItLegacy(text) {
	return /legacy|HDB_CONFIG_FILE|fallback|inherited from\s+the old|never (?:opened|parsed|read)|silently unread/i.test(
		text
	);
}

test('the example tells the reader to edit harper-config.yaml, by that name', () => {
	const readme = DOCUMENTS.find((doc) => doc.relative === 'example/README.md').body;
	assert.match(
		readme,
		new RegExp(`Merge the blocks from \`harper-config\\.example\\.yaml\` into \`<ROOTPATH>/${CURRENT}\``),
		`example/README.md step 3 must name <ROOTPATH>/${CURRENT}. The installer writes that ` +
			`file and pins it in the boot properties; anything else is a file Harper never opens.`
	);
});

test('the shipped template header names the file the installer wrote', () => {
	const template = DOCUMENTS.find((doc) => doc.relative === 'example/harper-config.example.yaml').body;
	const header = template.split('\n').slice(0, 12).join('\n');
	assert.ok(
		header.includes(`<ROOTPATH>/${CURRENT}`),
		`example/harper-config.example.yaml must point at <ROOTPATH>/${CURRENT} in its header, ` +
			`which is the only part of it a reader is guaranteed to see`
	);
});

test('NEGATIVE: nothing instructs the reader to create or edit the legacy file', () => {
	const instructions = [];
	for (const { relative, body } of DOCUMENTS) {
		for (const { number, text } of legacyMentions(body)) {
			if (!marksItLegacy(text)) instructions.push(`${relative}:${number}: ${text.trim()}`);
		}
	}
	assert.deepEqual(
		instructions,
		[],
		`${LEGACY} may be named only to say it is the legacy name. These lines name it as the ` +
			`file to use, which sends every key into a config Harper never parses:\n` +
			instructions.join('\n')
	);
});

test('the troubleshooting entry for a refused spawn names the config file, not just the allowlist', () => {
	const readme = DOCUMENTS.find((doc) => doc.relative === 'example/README.md').body;
	const row = readme.split('\n').find((line) => line.startsWith('| `Command /... is not allowed`'));
	assert.ok(row, 'the troubleshooting table must still carry a row for a refused spawn');
	assert.ok(
		row.includes('settings_path'),
		'the refused-spawn row must send the reader to the file Harper actually read ' +
			'(settings_path in the boot properties). Blaming the allowlist or a missing restart ' +
			'is what kept the real cause hidden.'
	);
});
