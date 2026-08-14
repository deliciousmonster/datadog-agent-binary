#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { getAllSupportedPlatforms } from '../dist/platform.js';
import { platformPackageName } from '../dist/package-identity.js';

const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const platforms = getAllSupportedPlatforms();

// The name convention lives in package-identity.ts, which exists because it was hardcoded
// in eleven places. Re-deriving it here would be the twelfth.
packageJson.optionalDependencies = {};
platforms.forEach((platform) => {
	packageJson.optionalDependencies[platformPackageName(platform)] = packageJson.version;
});

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, '\t') + '\n');

console.log(`Updated optionalDependencies to version ${packageJson.version}`);
