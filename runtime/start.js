// The start path: resolve every declared binary, fingerprint what would make a running one stale, hand the
// set to the supervisor, and report what happened.
//
// The spine of this is generic and is the largest single piece that belongs in the guard. Resolve, declare,
// fingerprint, supervise, collect states, report the ones that never started: none of that knows what
// Datadog is. What does is marked below, and it is four things — the API-key warning, the eBPF directory,
// the verifier, and which environment variables go into the fingerprint.

import { resolveBinary, resolveEbpfDir } from "./binary.js";
import { scheduleSeries } from "./process-metrics.js";
import { baseStatus } from "./status.js";
import { probeStatus } from "./system-probe.js";
import { nodeProcess, supervisorFor, unstarted } from "./supervisor.js";
import { verifyLaunch } from "./verify.js";

/**
 * @param {object} options
 * @param {readonly object[]} options.agents Declared processes, in start order.
 * @param {object} options.ports
 * @param {import('@deliciousmonster/harper-process-guard').Log} options.log
 * @param {Function} options.spawn Harper's constrained spawn.
 * @param {string} options.packageName
 * @param {(ebpfDir: string | null) => object} options.prepareRuntime
 * @param {import('./state.js').ComponentState} options.state
 */
export function createStart({
	agents,
	ports,
	log,
	spawn,
	packageName,
	prepareRuntime,
	state,
}) {
	/** The started state for one process on this thread, or undefined before startup produced one. */
	const startedProcess = (name) =>
		state.started.find((process) => process?.name === name);

	// Never rejects: a throw out of handleApplication plants an ErrorResource at the component's root path,
	// which is worse than running without telemetry and saying so.
	return async function start(scope) {
		const supervision = supervisorFor(scope, { log, spawn });
		const status = { supervision: supervision.kind, ...baseStatus(ports) };
		try {
			// Datadog-specific: measured on 7.82.1 rather than inferred from one shared config, because the
			// two agents fail differently and an operator needs to know which silence they are looking at.
			if (!process.env.DD_API_KEY)
				log.warn(
					"Datadog supervisor: DD_API_KEY is not set. The core agent starts and collects, and the intake " +
						"refuses every payload it sends with a 403. The trace-agent does not start at all: it exits " +
						'immediately with "you must specify an API Key", so nothing binds the receiver, the supervisor ' +
						"restarts it until it gives up, and dd-trace has nowhere to send spans."
				);

			// Before prepareRuntime, because the objects' path is written into the config it renders.
			const ebpfDir = await resolveEbpfDir();
			const runtime = prepareRuntime(ebpfDir);
			// The read path re-reads the reaper's lock, and this is the only place the path is known.
			state.pidDir = runtime.paths.pidDir;
			state.traceLogPath = runtime.paths.traceLog;
			Object.assign(status, {
				runtimeDir: runtime.paths.runtimeDir,
				configFile: runtime.paths.configFile,
				coreChecks: runtime.coreChecks,
				probes: probeStatus(runtime.probes, ebpfDir, { log, packageName }),
			});

			// Only what this node asked for. An optional process nobody enabled is not declared at all, so
			// it cannot be resolved, cannot fail to resolve, and cannot appear in the status as a thing
			// that broke.
			const wanted = agents.filter(
				(agent) => !agent.optional || agent.enabled(runtime.probes)
			);

			// Resolved up front so the fingerprint can never describe a different binary from the one spawned.
			const failures = [];
			const binaries = await Promise.all(
				wanted.map((agent, index) =>
					resolveBinary(agent).catch((error) => {
						failures[index] = error.message;
						// An optional process this node asked for and cannot find is the operator's own
						// misconfiguration to fix, not a defect: they set the flag and did not install the
						// package. It is still a refusal to run something requested, so it is logged.
						log.error(
							`Datadog supervisor: could not resolve the ${agent.title} binary: ${error.message}`
						);
						return "";
					})
				)
			);

			// Datadog-specific: the credentials ride in the inherited environment, invisible to the config
			// contents, so a rotated key must be folded in here or a thread joins an agent still posting
			// under the old one.
			const fingerprintParts = [
				...Object.values(runtime.configFiles),
				process.env.DD_API_KEY ?? "",
				process.env.DD_SITE ?? "",
				process.env.DD_ENV ?? "",
				...binaries,
			];

			const verifyContext = { paths: runtime.paths, ports };
			const declared = wanted.map((agent, index) => ({
				...agent,
				command: binaries[index],
				args: agent.args(runtime.paths),
				verify: (launched) => verifyLaunch(agent, launched, verifyContext),
			}));

			// Reported here rather than inside a supervisor, so the two of them cannot describe the same
			// unresolvable binary in different words.
			state.verifiers = new Map(declared.map((a) => [a.name, a.verify]));
			const startable = declared.filter((agent) => agent.command);
			const started = startable.length
				? await supervision.start(startable, {
						runtime,
						configFiles: runtime.configFiles,
						fingerprintParts,
					})
				: { processes: [], report: [] };

			const states = new Map(
				startable.map((agent, index) => [agent.name, started.processes[index]])
			);
			status.processes = declared.map(
				(agent, index) =>
					states.get(agent.name) ?? unstarted(agent, failures[index])
			);
			state.started = status.processes;
			if (started.reaper) status.reaper = started.reaper;
			if (started.report?.length) status.supervisionReport = started.report;

			const series = scheduleSeries({
				pidDir: runtime.paths.pidDir,
				confd: runtime.paths.confd,
				port: ports.dogstatsd,
				log,
				previous: state.series,
				members: () => [
					{ name: "harper", self: true },
					...agents
						.map((agent) => {
							const live = nodeProcess(
								startedProcess(agent.name),
								runtime.paths.pidDir
							);
							return { name: agent.name, pid: live?.pid };
						})
						.filter((member) => Number.isInteger(member.pid)),
				],
			});
			state.series = series.series;
			status.processMetrics = series.state;
		} catch (error) {
			status.error = error.message;
			log.error(
				`Datadog supervisor: startup failed: ${error.stack ?? error.message}`
			);
		}
		return status;
	};
}
