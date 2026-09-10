// How the binaries are split across npm packages, stated once.
//
// Two packages per platform, and the split is `from`. The base package carries what this repo builds: the
// core agent and the trace-agent, which is what a Harper node needs to send metrics and traces. The probe
// package carries what is lifted out of Datadog's release: system-probe, security-agent, and the 42 MB of
// precompiled eBPF objects system-probe is useless without.
//
// The probe package is not an optionalDependency, so it is not installed unless an operator asks for it.
// That is the whole reason for the split. system-probe wants CAP_SYS_ADMIN or root and a kernel it has an
// object for, security-agent wants a runtime-security policy set, and neither does anything on a node that
// has not configured them. Shipping 145 MB per platform to every install so that a minority can turn on a
// feature is the cost the base package refuses; publishing them so the minority can have them is the
// capability the split preserves. Nothing is dropped, and nothing is paid for twice.
//
// create-platform-packages.js, verify-package.js and update-optional-deps.js all read these, so a rename
// cannot land in two of the three.

import { AgentBinary, builtFor, extractedFor } from "./binaries.js";
import { Target } from "./targets.js";

export const SCOPE = "@deliciousmonster/datadog-agent-binary";

/** What a platform package is: its npm name, the directory it is staged in, and what it carries. */
export interface PlatformPackage {
	readonly name: string;
	/** Directory name under `npm/`. Matches the npm name's last segment so the two never drift. */
	readonly dirName: string;
	readonly target: Target;
	readonly binaries: readonly AgentBinary[];
	/** Whether the base package lists this one in optionalDependencies. */
	readonly optionalDependency: boolean;
	/** Whether this package also ships the precompiled eBPF objects beside its binaries. */
	readonly ebpf: boolean;
	readonly description: string;
}

const base = (target: Target): PlatformPackage => ({
	name: `${SCOPE}-${target.name}`,
	dirName: target.name,
	target,
	binaries: builtFor(target),
	optionalDependency: true,
	ebpf: false,
	description: `Datadog core agent and trace-agent for ${target.os} ${target.arch}`,
});

const probe = (target: Target): PlatformPackage => ({
	name: `${SCOPE}-probe-${target.name}`,
	dirName: `probe-${target.name}`,
	target,
	binaries: extractedFor(target),
	// Deliberately not an optionalDependency. npm would install it on every matching host, which is the
	// 145 MB the split exists to avoid charging people who never turn these on.
	optionalDependency: false,
	ebpf: extractedFor(target).some((b) => b.shipsAs === "system-probe"),
	description: `Datadog system-probe and security-agent for ${target.os} ${target.arch}`,
});

/** Every package one target publishes. A target with nothing to extract publishes only its base package. */
export function packagesFor(target: Target): PlatformPackage[] {
	const packages = [base(target)];
	if (extractedFor(target).length > 0) packages.push(probe(target));
	return packages;
}

/** Every package across every target, which is what the publish job and the publish gate both walk. */
export const allPackages = (targets: readonly Target[]): PlatformPackage[] =>
	targets.flatMap(packagesFor);
