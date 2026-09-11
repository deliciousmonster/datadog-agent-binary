// The core agent logged `handleServiceDiscoveryRequestError` once a minute for a day, 1,216 lines on the
// 2026-09-08 run.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { guardDescriptors } from "@deliciousmonster/harper-process-guard";
import { loadComponent } from "../support/component.js";

const { AGENTS } = await loadComponent();

const inherited = {
	DD_API_KEY: "secret",
	DD_SITE: "datadoghq.com",
	PATH: "/bin",
};
const agent = (over = {}) => ({
	name: "datadog-agent",
	title: "core agent",
	command: "/bin/datadog-agent",
	args: ["run"],
	verify: async () => ({ ok: true, detail: "" }),
	...over,
});

describe("the environment each agent is spawned with", () => {
	it("carries a declared variable through to the guard's spawn options", () => {
		const [d] = guardDescriptors(
			[agent({ env: { DD_DISCOVERY_ENABLED: "false" } })],
			inherited
		);
		assert.equal(d.spawnOptions.env.DD_DISCOVERY_ENABLED, "false");
	});

	it("keeps the inherited environment, because naming env at all replaces it", () => {
		// The failure this guards against is silent and total: an agent spawned with only the declared
		// variable has no DD_API_KEY, so it starts, verifies, and delivers nothing.
		const [d] = guardDescriptors(
			[agent({ env: { DD_DISCOVERY_ENABLED: "false" } })],
			inherited
		);
		assert.equal(d.spawnOptions.env.DD_API_KEY, "secret");
		assert.equal(d.spawnOptions.env.DD_SITE, "datadoghq.com");
		assert.equal(d.spawnOptions.env.PATH, "/bin");
	});

	it("lets the declared variable win over an inherited one of the same name", () => {
		const [d] = guardDescriptors(
			[agent({ env: { DD_DISCOVERY_ENABLED: "false" } })],
			{ ...inherited, DD_DISCOVERY_ENABLED: "true" }
		);
		assert.equal(d.spawnOptions.env.DD_DISCOVERY_ENABLED, "false");
	});

	it("NEGATIVE: an agent declaring no env gets no spawnOptions, so it inherits as before", () => {
		const [d] = guardDescriptors([agent()], inherited);
		assert.equal(
			d.spawnOptions,
			undefined,
			"an empty env object is not the same as no env, and would replace the environment"
		);
	});

	it("NEGATIVE: carries every field the guard needs, so adding env cannot drop one", () => {
		const [d] = guardDescriptors([agent({ exitHint: "hint" })], inherited);
		assert.deepEqual(Object.keys(d).sort(), [
			"args",
			"binaryPath",
			"exitHint",
			"name",
			"title",
			"verify",
		]);
	});

	it("NEGATIVE: no agent ships with a hard-coded env, because that would outrank the operator", () => {
		// The mechanism exists for a setting an agent genuinely needs and an operator has no reason to change.
		for (const a of AGENTS)
			assert.equal(a.env, undefined, `${a.name} declares a hard-coded env`);
	});
});
