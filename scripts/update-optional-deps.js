#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const { getAllSupportedPlatforms } = require("../dist/platform.js");
const platforms = getAllSupportedPlatforms();

// Platform sub-packages are named `<this package>-<platform>`, derived from the
// manifest rather than hardcoded, so re-scoping the project is a one-line edit to
// package.json's `name` and every derived name follows.
const packageName = packageJson.name;
if (!packageName) {
	throw new Error(
		"package.json has no `name`; cannot derive platform package names."
	);
}

// Update optionalDependencies to use the same version as the main package
packageJson.optionalDependencies = {};
platforms.forEach((platform) => {
	packageJson.optionalDependencies[`${packageName}-${platform}`] =
		packageJson.version;
});

fs.writeFileSync(
	packageJsonPath,
	JSON.stringify(packageJson, null, "\t") + "\n"
);

console.log(`Updated optionalDependencies to version ${packageJson.version}`);
