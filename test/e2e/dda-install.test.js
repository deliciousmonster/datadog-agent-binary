import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// pipx builds each venv with the interpreter pipx was installed under, so ubuntu-22.04's 3.10 pipx

// rejected every published dda against upstream's 3.12 pin and twelve nightly builds died on it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("../support/generator.js");
const { withTempDir } = require("../support/sandbox.js");
const { pipxInterpreter, pythonPin } = require(
	path.join(REPO_ROOT, "dist", "build.js")
);

// Probes are supplied rather than run: the host's own python decides nothing here.
const probing = (reported) => {
	const asked = [];
	const probe = async (candidate) => {
		asked.push(candidate);
		if (!(candidate in reported)) throw new Error(`${candidate}: not found`);
		return `${reported[candidate]}\n`;
	};
	return { asked, probe };
};

test("the interpreter satisfying the pin is handed to pipx, which cannot pick it itself", async () => {
	const { probe } = probing({
		python3: "3.12 /opt/hostedtoolcache/Python/3.12.8/x64/bin/python3",
	});
	assert.deepEqual(await pipxInterpreter("3.12", probe), [
		"--python",
		"/opt/hostedtoolcache/Python/3.12.8/x64/bin/python3",
	]);
});

test("an interpreter newer than the pin satisfies it", async () => {
	const { probe } = probing({ python3: "3.13 /usr/bin/python3.13" });
	assert.deepEqual(await pipxInterpreter("3.12", probe), [
		"--python",
		"/usr/bin/python3.13",
	]);
});

test("a PATH interpreter below the pin is not passed, since pipx's own default may be newer", async () => {
	const { probe } = probing({ python3: "3.10 /usr/bin/python3" });
	assert.deepEqual(await pipxInterpreter("3.12", probe), []);
});

// 3.9 sorts above 3.12 as text and equals it as a float; both readings pass an interpreter that
// cannot install dda.
test("minor versions compare as numbers, so 3.9 does not satisfy a 3.12 pin", async () => {
	const { probe } = probing({ python3: "3.9 /usr/bin/python3.9" });
	assert.deepEqual(await pipxInterpreter("3.12", probe), []);
});

test("python3 absent falls through to python, which is the spelling Windows ships", async () => {
	const { asked, probe } = probing({
		python: "3.12 C:\\hostedtoolcache\\Python\\3.12.8\\x64\\python.exe",
	});
	assert.deepEqual(await pipxInterpreter("3.12", probe), [
		"--python",
		"C:\\hostedtoolcache\\Python\\3.12.8\\x64\\python.exe",
	]);
	assert.deepEqual(asked, ["python3", "python"]);
});

test("a source shipping no .python-version has no opinion, and no interpreter is probed", async () => {
	const { asked, probe } = probing({ python3: "3.12 /usr/bin/python3" });
	assert.deepEqual(await pipxInterpreter("", probe), []);
	assert.deepEqual(asked, []);
});

test("the pin is read from the source tree the tag unpacked, and trimmed", async () => {
	await withTempDir("ddab-pin-", async (dir) => {
		assert.equal(await pythonPin(dir), "");
		fs.writeFileSync(path.join(dir, ".python-version"), "3.12\n");
		assert.equal(await pythonPin(dir), "3.12");
	});
});
