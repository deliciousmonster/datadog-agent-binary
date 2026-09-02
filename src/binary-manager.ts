import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "./logger.js";
import { AgentBinary, BINARIES } from "./binaries.js";
import { currentTarget, Target } from "./targets.js";

export interface BinaryInfo {
	version: string;
	target: Target;
	downloadUrl: string;
	fileName: string;
	checksum?: string;
}

export class BinaryManager {
	private readonly buildDir: string;
	private readonly binDir: string;

	constructor() {
		this.buildDir = path.join(__dirname, "..", "build");
		this.binDir = path.join(__dirname, "..", "bin");
	}

	async ensureBinary(version?: string): Promise<string> {
		const target = currentTarget();
		logger.info(
			`Resolving Datadog Agent binary for platform ${target.name} ` +
				`(process.platform=${process.platform}, process.arch=${process.arch})`
		);

		// Prefer a prebuilt binary shipped via the optional platform package
		// (e.g. @harperfast/datadog-agent-binary-linux-x86_64). This is the
		// path used when the package is installed from npm.
		const packagedBinary = await this.resolveFromPlatformPackage(target);
		if (packagedBinary) {
			logger.info(`Using packaged Datadog Agent binary: ${packagedBinary}`);
			return packagedBinary;
		}

		// Fall back to a locally built binary (build-from-source workflow).
		logger.warn(
			`No packaged binary resolved for ${target.name}; falling back to ` +
				`the build-from-source lookup. This needs a network call to GitHub and ` +
				`a binary under ${this.buildDir}. In a Harper runtime this almost always ` +
				`means the optional platform package ` +
				`@harperfast/datadog-agent-binary-${target.name} was not installed.`
		);
		const targetVersion = version || (await this.getLatestVersion());
		const binaryPath = await this.getBinaryPath(
			BINARIES[0],
			target,
			targetVersion
		);

		if (await this.binaryExists(binaryPath)) {
			logger.info(`Using locally built Datadog Agent binary: ${binaryPath}`);
			return binaryPath;
		}

		throw new Error(
			`Datadog Agent binary not found for ${target.name}. Checked the ` +
				`optional platform package ` +
				`@harperfast/datadog-agent-binary-${target.name} and the local ` +
				`build path ${binaryPath}; neither resolved a runnable binary.`
		);
	}

	/**
	 * Attempts to resolve the agent binary from the optional platform package
	 * for the current platform. Returns the binary path if the package is
	 * installed and the binary exists, otherwise null.
	 */
	private async resolveFromPlatformPackage(
		target: Target
	): Promise<string | null> {
		const packageName = `@harperfast/datadog-agent-binary-${target.name}`;
		logger.debug(`Attempting to resolve platform package ${packageName}`);
		try {
			const pkg = (await import(packageName)) as {
				default?: { getBinaryPath?: (name?: string) => string };
				getBinaryPath?: (name?: string) => string;
			};
			const getBinaryPath = pkg.getBinaryPath || pkg.default?.getBinaryPath;
			if (typeof getBinaryPath !== "function") {
				logger.warn(
					`Platform package ${packageName} loaded but does not export a ` +
						`getBinaryPath() function — cannot resolve the agent binary from it.`
				);
				return null;
			}
			const binaryPath = getBinaryPath(BINARIES[0].shipsAs);
			logger.debug(`${packageName} reports binary path: ${binaryPath}`);
			if (await this.binaryExists(binaryPath)) {
				return binaryPath;
			}
			logger.warn(
				`Platform package ${packageName} resolved but its binary is missing ` +
					`at ${binaryPath}.`
			);
			return null;
		} catch (error: any) {
			// Most commonly this means the optional dependency was skipped for
			// this platform/arch. But it can also hide a real load failure, so
			// surface the reason instead of swallowing it silently.
			logger.warn(
				`Could not load platform package ${packageName}: ${error?.message ?? error}. ` +
					`If this platform should be supported, confirm the optional dependency ` +
					`is installed (npm may skip it on os/cpu mismatch or with --no-optional).`
			);
			return null;
		}
	}

	private async getBinaryPath(
		binary: AgentBinary,
		target: Target,
		version: string
	): Promise<string> {
		const fileName = `${binary.shipsAs}${target.exe}`;
		return path.join(this.buildDir, `${version}-${target.name}`, fileName);
	}

	private async binaryExists(binaryPath: string): Promise<boolean> {
		try {
			const stat = await fs.stat(binaryPath);
			return stat.isFile();
		} catch {
			return false;
		}
	}

	private async getLatestVersion(): Promise<string> {
		const response = await fetch(
			"https://api.github.com/repos/DataDog/datadog-agent/releases/latest"
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch latest version: ${response.statusText}`);
		}

		const data = (await response.json()) as { tag_name: string };
		return data.tag_name;
	}

	async createBinaryWrapper(): Promise<void> {
		const wrapperPath = path.join(this.binDir, "datadog-agent");
		const target = currentTarget();

		let wrapperContent: string;

		if (target.os === "windows") {
			wrapperContent = this.createWindowsWrapper();
			await fs.writeFile(wrapperPath + ".cmd", wrapperContent);
		} else {
			wrapperContent = this.createUnixWrapper();
			await fs.writeFile(wrapperPath, wrapperContent);
			await fs.chmod(wrapperPath, 0o755);
		}

		logger.debug(`Created binary wrapper: ${wrapperPath}`);
	}

	private createUnixWrapper(): string {
		return `#!/usr/bin/env node

const { BinaryManager } = require('../dist/binary-manager.js');
const { spawn } = require('child_process');
const path = require('path');

async function main() {
  try {
    const manager = new BinaryManager();
    const binaryPath = await manager.ensureBinary();

    // Harper v5 requires \`name\` on spawn options when invoked from inside a
    // Harper application — it lets Harper dedupe the child across worker
    // threads. The option is silently ignored by stock Node.js, so this is
    // safe outside Harper too.
    const child = spawn(binaryPath, process.argv.slice(2), {
      stdio: 'inherit',
      env: process.env,
      name: 'datadog-agent'
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });

  } catch (error) {
    console.error('Failed to run datadog-agent:', error.message);
    process.exit(1);
  }
}

main();
`;
	}

	private createWindowsWrapper(): string {
		// The original cmd wrapper invoked `dist/binary-manager.js` directly,
		// but that file is a module — it has no top-level main and never
		// spawned the agent. Delegate to the same Node wrapper logic used on
		// Unix so the agent binary is actually launched (with the v5-required
		// `name` option).
		//
		// Three Windows-specific gotchas the implementation works around:
		//   1. Inlining %~dp0 into the JS string literal corrupts the path —
		//      backslashes get interpreted as JS escapes (\U, \b, ...). Pass
		//      the path through argv instead so it stays a literal string.
		//   2. %~dp0 always has a trailing backslash, so "%~dp0" becomes
		//      "...\foo\" — the MS argv parser treats \" as a literal quote
		//      and the next user arg bleeds in. Appending a dot ("%~dp0.")
		//      makes the trailing char `.`, which path.join normalizes away.
		//   3. With `node -e "<code>" "<path>" <args...>`, there is no script
		//      slot in argv — the path lands at argv[1] and user args start at
		//      argv[2] (unlike `node script.js` where argv[1] is the script).
		return `@echo off
node -e "const path=require('path');const{spawn}=require('child_process');(async()=>{try{const{BinaryManager}=require(path.join(process.argv[1],'..','dist','binary-manager.js'));const m=new BinaryManager();const b=await m.ensureBinary();const c=spawn(b,process.argv.slice(2),{stdio:'inherit',env:process.env,name:'datadog-agent'});c.on('exit',code=>process.exit(code||0));}catch(e){console.error('Failed to run datadog-agent:',e.message);process.exit(1);}})()" "%~dp0." %*
`;
	}

	async installForCurrentPlatform(): Promise<void> {
		const target = currentTarget();
		logger.info(`Installing Datadog Agent binary for ${target.name}...`);

		try {
			await this.ensureBinary();
			await this.createBinaryWrapper();
			logger.info("Installation completed successfully");
		} catch (error: any) {
			logger.error(`Installation failed: ${error.message}`);
			throw error;
		}
	}
}
