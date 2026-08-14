"use strict";

const net = require("node:net");

/**
 * A 127.0.0.1 port with nothing listening on it. Callers need the trace
 * launcher's already-running probe to find silence, so the momentary listener
 * is closed before the port is handed back.
 */
function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

module.exports = { findFreePort };
