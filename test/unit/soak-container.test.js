// A recreate replays the live container's own run configuration. The failure this guards is silent and total:
// drop the root mount and docker satisfies the image's declared VOLUME with a fresh anonymous one, Harper comes
// up with an empty components/ directory, and the run keeps writing rows against a container with no plugin in
// it. A dangling anonymous volume on 2026-09-15 carried exactly that shape, an empty components/ beside a fresh
// 23 MB database, which is what a container booted without the named volume leaves behind.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mountArgs, mountsPath } from "../../test/soak/soak-container.mjs";

const ROOT = "/home/harperdb/harper";

// The live container on 2026-09-15: created with -v, so all three land in Binds and Mounts is empty.
const VIA_V = {
	Binds: [
		`harper-demo-vol:${ROOT}`,
		"/sys/kernel/debug:/sys/kernel/debug",
		"/sys/kernel/tracing:/sys/kernel/tracing",
	],
	Mounts: [],
};

test("a container created with -v replays every mount it has", () => {
	assert.deepEqual(mountArgs(VIA_V), [
		"-v",
		`harper-demo-vol:${ROOT}`,
		"-v",
		"/sys/kernel/debug:/sys/kernel/debug",
		"-v",
		"/sys/kernel/tracing:/sys/kernel/tracing",
	]);
	assert.equal(mountsPath(mountArgs(VIA_V), ROOT), true);
});

// The case that read as zero mounts: --mount records in Mounts, and Binds is then null. Reading only Binds
// produced a spec with no -v at all, which is the empty-volume recreate.
test("a container created with --mount replays its volume too, not an empty list", () => {
	const viaMount = {
		Binds: null,
		Mounts: [
			{ Type: "volume", Name: "harper-demo-vol", Target: ROOT },
			{
				Type: "bind",
				Source: "/sys/kernel/debug",
				Target: "/sys/kernel/debug",
			},
		],
	};
	const args = mountArgs(viaMount);
	assert.deepEqual(args, [
		"-v",
		`harper-demo-vol:${ROOT}`,
		"-v",
		"/sys/kernel/debug:/sys/kernel/debug",
	]);
	assert.equal(
		mountsPath(args, ROOT),
		true,
		"this is the spec that used to carry no -v at all"
	);
});

test("a read-only mount keeps its flag, and a mount named twice is replayed once", () => {
	assert.deepEqual(
		mountArgs({
			Binds: [],
			Mounts: [{ Type: "bind", Source: "/a", Target: "/b", ReadOnly: true }],
		}),
		["-v", "/a:/b:ro"]
	);
	assert.deepEqual(
		mountArgs({
			Binds: [`harper-demo-vol:${ROOT}`],
			Mounts: [{ Type: "volume", Name: "harper-demo-vol", Target: ROOT }],
		}),
		["-v", `harper-demo-vol:${ROOT}`],
		"Binds and Mounts describing the same mount must not produce it twice"
	);
});

test("NEGATIVE: a spec with no mount at the root is refused rather than recreated", () => {
	assert.equal(
		mountsPath(mountArgs({ Binds: null, Mounts: null }), ROOT),
		false
	);
	assert.equal(mountsPath(mountArgs({ Binds: [], Mounts: [] }), ROOT), false);
	assert.equal(
		mountsPath(
			["run", "-d", "--name", "harper-demo", "harperfast/harper:5.2.9"],
			ROOT
		),
		false,
		"the exact shape that boots Harper on a fresh anonymous volume"
	);
});

// The destination is the second field. A source path that happens to contain the root is not a mount at it.
test("NEGATIVE: the root is matched as a destination, not anywhere in the string", () => {
	assert.equal(mountsPath(["-v", `${ROOT}:/elsewhere`], ROOT), false);
	assert.equal(mountsPath(["-v", `/backup${ROOT}:/other`], ROOT), false);
	assert.equal(mountsPath(["-v", `vol:${ROOT}-old`], ROOT), false);
	assert.equal(mountsPath(["-v", `vol:${ROOT}`], ROOT), true);
	assert.equal(
		mountsPath(["-v", `vol:${ROOT}:ro`], ROOT),
		true,
		"a read-only root is still the root"
	);
});

// `-v` is a flag, so the value only counts in that position. A bare argument that looks like a mount is not one.
test("NEGATIVE: only a value that follows -v counts", () => {
	assert.equal(mountsPath([`vol:${ROOT}`], ROOT), false);
	assert.equal(mountsPath(["-e", `vol:${ROOT}`], ROOT), false);
});
