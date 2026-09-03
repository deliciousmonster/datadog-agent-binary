// Loopback endpoints the component suites point probes at. A stub that answered every path would let a
// typo in the probe URL pass, so each one answers exactly the path it is given and 404s the rest.

import http from "node:http";
import net from "node:net";

/** A 127.0.0.1 port with nothing listening: the momentary listener closes before the port is handed back. */
export function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** `run` against a server listening on an ephemeral 127.0.0.1 port, closed however `run` ends. */
export async function withServer(server, run) {
	const port = await new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(server.address().port))
	);
	try {
		return await run(port);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

/** An unstarted HTTP server answering `answers` with `body`, and 404 everywhere else. */
// `body` may be a function so a stub can answer with something only known once the component has
// run, such as the pid that ended up on the lock. A static object cannot report a pid it predates.
export function createStub({
	status = 200,
	body = {},
	answers = "/info",
} = {}) {
	return http.createServer((request, response) => {
		const head = { "content-type": "application/json" };
		if (request.url !== answers) {
			response.writeHead(404, head);
			response.end("{}");
			return;
		}
		response.writeHead(status, head);
		response.end(JSON.stringify(typeof body === "function" ? body() : body));
	});
}

/** `run` with console.warn and console.error captured, which is where the component logs without Harper. */
export async function captureLogs(run) {
	const lines = [];
	const real = { warn: console.warn, error: console.error };
	console.warn = (...args) => lines.push(args.join(" "));
	console.error = (...args) => lines.push(args.join(" "));
	try {
		await run();
	} finally {
		Object.assign(console, real);
	}
	return lines;
}
