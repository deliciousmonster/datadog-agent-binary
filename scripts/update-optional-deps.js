#!/usr/bin/env node

import { createRequire } from "node:module";
import { REPO_ROOT } from "./paths.js";

const require = createRequire(import.meta.url);

const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(REPO_ROOT, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const { targetNames } = require("../dist/src/targets.js");
const platforms = targetNames();

// Update optionalDependencies to use the same version as the main package
packageJson.optionalDependencies = {};
platforms.forEach((platform) => {
	packageJson.optionalDependencies[
		`@harperfast/datadog-agent-binary-${platform}`
	] = packageJson.version;
});

fs.writeFileSync(
	packageJsonPath,
	JSON.stringify(packageJson, null, "\t") + "\n"
);

console.log(`Updated optionalDependencies to version ${packageJson.version}`);
