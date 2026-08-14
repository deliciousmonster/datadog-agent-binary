#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { getAllSupportedPlatforms } from '../dist/platform.js';

const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const platforms = getAllSupportedPlatforms();

// Platform sub-packages are named `<this package>-<platform>`, derived from the
// manifest so re-scoping is a one-line edit to package.json's `name`.
const packageName = packageJson.name;
if (!packageName) {
	throw new Error('package.json has no `name`; cannot derive platform package names.');
}

packageJson.optionalDependencies = {};
platforms.forEach((platform) => {
	packageJson.optionalDependencies[`${packageName}-${platform}`] = packageJson.version;
});

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, '\t') + '\n');

console.log(`Updated optionalDependencies to version ${packageJson.version}`);
