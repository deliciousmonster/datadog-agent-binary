#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.js";
import { TARGETS } from "../dist/src/targets.js";
import { allPackages } from "../dist/src/packages.js";

const packageJsonPath = join(REPO_ROOT, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Only the packages that say they belong here. The probe packages publish at the same version and are
// deliberately absent: npm installs an optionalDependency on every host whose os and cpu match, so listing
// them would charge every install for system-probe and its 42 MB of eBPF objects, which is what splitting
// them out was for. An operator who wants them installs one by name.
packageJson.optionalDependencies = {};
for (const pkg of allPackages(TARGETS).filter((p) => p.optionalDependency)) {
	packageJson.optionalDependencies[pkg.name] = packageJson.version;
}

writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, "\t") + "\n");

console.log(`Updated optionalDependencies to version ${packageJson.version}`);
