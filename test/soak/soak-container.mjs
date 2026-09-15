/*
 * The mounts a recreate has to replay, split out of soak.mjs so both decisions have tests.
 *
 * A recreate reads the live container's own run configuration and replays it. If it replays the wrong set,
 * Harper comes up on a fresh empty volume with no component in it, the agents are simply absent, and the run
 * keeps writing rows against a container that is testing nothing. So the root mount is checked rather than
 * assumed.
 */

/**
 * Every mount in a container's HostConfig as `-v` arguments. Docker records a mount in `Binds` when the
 * container was created with `-v`, and in `Mounts` when it was created with `--mount`; reading only `Binds`
 * drops the volume entirely for the second kind.
 *
 * @param {{Binds?: string[] | null, Mounts?: Array<{Type?: string, Source?: string, Name?: string, Target?: string, ReadOnly?: boolean}> | null}} hostConfig
 * @returns {string[]} flat ["-v", spec, "-v", spec, ...]
 */
export function mountArgs(hostConfig) {
	const specs = [...(hostConfig?.Binds ?? [])];
	for (const m of hostConfig?.Mounts ?? []) {
		const source = m.Source || m.Name;
		if (!source || !m.Target) continue;
		const spec = `${source}:${m.Target}${m.ReadOnly ? ":ro" : ""}`;
		if (
			!specs.some((s) => s === spec || s.startsWith(`${source}:${m.Target}:`))
		)
			specs.push(spec);
	}
	return specs.flatMap((spec) => ["-v", spec]);
}

/**
 * Whether `args` mounts something at `path`. The destination is the second colon-separated field, so a source
 * that merely contains the path does not count: `/home/harperdb/harper:/elsewhere` mounts nothing at it.
 *
 * @param {readonly string[]} args @param {string} path
 */
export function mountsPath(args, path) {
	return args.some(
		(arg, i) =>
			args[i - 1] === "-v" &&
			typeof arg === "string" &&
			arg.split(":")[1] === path
	);
}
