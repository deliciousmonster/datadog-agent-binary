/**
 * Harper component entry that probes native importability of the published
 * package at component load and records JSONL for
 * test/integration/harper-import.test.ts to read back.
 *
 * That test stages this file into a scratch Harper application next to an
 * installed copy of the tarball npm would publish. The package under test is
 * named through DD_IMPORT_PACKAGE_NAME rather than written into this source,
 * so a re-scope cannot leave the probe importing a name the package no longer
 * publishes under. Self-contained on purpose: the staged application cannot
 * resolve this repo's test/support modules, so the JSONL writer and the error
 * rendering stay inline.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = process.env.DD_IMPORT_PROBE_DIR;
/** The published package name; every probe below imports this specifier. */
const PACKAGE_NAME = process.env.DD_IMPORT_PACKAGE_NAME;

function record(entry) {
	appendFileSync(
		join(PROBE_DIR, "probe-results.jsonl"),
		JSON.stringify(entry) + "\n"
	);
}

async function probe(name, run) {
	try {
		record({ probe: name, threw: false, ...(await run()) });
	} catch (error) {
		record({
			probe: name,
			threw: true,
			error: String(error?.message ?? error),
		});
	}
}

if (PROBE_DIR && PACKAGE_NAME) {
	// An async IIFE instead of top-level await: the loader's TLA support is not
	// what is under test, and the suite polls the results file for "done".
	(async () => {
		// Only Harper's application loader resolves 'harper' to its synthetic
		// module; under plain Node this import fails. Every probe below is
		// meaningless unless this row shows the loader mediating our imports.
		await probe("harper-module", async () => {
			const harper = await import("harper");
			return {
				hasResource: typeof harper.Resource === "function",
				hasTables: "tables" in harper,
			};
		});
		// 'harper/*' subpaths are reserved and must be refused; the refusal is
		// the second enforcement signal.
		await probe("harper-subpath", async () => {
			await import("harper/loader-probe");
			return {};
		});
		await probe("native-import", async () => {
			const mod = await import(PACKAGE_NAME);
			return {
				exportKeys: Object.keys(mod).length,
				hasDatadogAgentBuilder: typeof mod.DatadogAgentBuilder === "function",
				hasBinaryManager: typeof mod.BinaryManager === "function",
				builderHasBuildForPlatform:
					typeof mod.DatadogAgentBuilder?.prototype?.buildForPlatform ===
					"function",
			};
		});
		// createRequire reaches Node's real CJS cache. A natively loaded package
		// shares one evaluation with it; a package claimed by the application
		// loader is a separate compartment evaluation, so the class identities
		// split. Verified in both directions against harper 5.2.1 by flipping
		// `harper` in the staged manifest's devDependencies.
		await probe("native-identity", async () => {
			const mod = await import(PACKAGE_NAME);
			const { createRequire } = await import("node:module");
			const viaRequire = createRequire(import.meta.url)(PACKAGE_NAME);
			return {
				sameClass: viaRequire.DatadogAgentBuilder === mod.DatadogAgentBuilder,
			};
		});
		record({ probe: "done", threw: false });
	})();
}
