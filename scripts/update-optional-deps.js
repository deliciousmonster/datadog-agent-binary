#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.js";
import { targetNames } from "../dist/src/targets.js";

const packageJsonPath = join(REPO_ROOT, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const platforms = targetNames();

// Update optionalDependencies to use the same version as the main package
packageJson.optionalDependencies = {};
platforms.forEach((platform) => {
	packageJson.optionalDependencies[`${packageJson.name}-${platform}`] =
		packageJson.version;
});

writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, "\t") + "\n");

console.log(`Updated optionalDependencies to version ${packageJson.version}`);
