// The one thing a plaintext stub cannot stand in for: the trace-agent serves its expvar under a self-signed IPC
// certificate, and every probe that reads it goes over https.

import https from "node:https";

// Self-signed, for 127.0.0.1, valid for a century.
const TEST_ONLY_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgarF6Z1XpxwYrKQuH
DgtiUrbspwokWGSdFIO6M+5mrFOhRANCAATzNHyopkFHrXBcaMtiUDJOqYAIWFac
ljPVZHXaBSt9fXzsjD3MEN1EBSIUE5IuLKIToD7Mfh4fUe21ZcaFKxgd
-----END PRIVATE KEY-----
`;

const TEST_ONLY_CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATagAwIBAgIUReD+SgKEmwJqEEbQmzXEax4D/LUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDkwNTEwMDA1NloYDzIxMjYwODEy
MTAwMDU2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATzNHyopkFHrXBcaMtiUDJOqYAIWFacljPVZHXaBSt9fXzsjD3MEN1E
BSIUE5IuLKIToD7Mfh4fUe21ZcaFKxgdo2QwYjAdBgNVHQ4EFgQUsLz4ScQWv80y
/0fXhWTW53mgIPYwHwYDVR0jBBgwFoAUsLz4ScQWv80y/0fXhWTW53mgIPYwDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUC
IQDQ8Wqnm8yKWsthaHLhVEsDuwTo2pH6eYYV1AZdaOilRgIgBRyORaQi05ZZEq/V
v7rIPFIHYNh/n0B/S0CqgRbwszc=
-----END CERTIFICATE-----
`;

const CREDENTIALS = { key: TEST_ONLY_KEY, cert: TEST_ONLY_CERT };

/**
 * An unstarted https server answering `answers` with `body` at 200, and 404 everywhere else, the way
 * loopback.js's plaintext stub does.
 */
export function createTlsStub({ body = {}, answers = "/debug/vars" } = {}) {
	return https.createServer(CREDENTIALS, (request, response) => {
		const head = { "content-type": "application/json" };
		if (request.url !== answers) {
			response.writeHead(404, head);
			response.end("{}");
			return;
		}
		response.writeHead(200, head);
		response.end(JSON.stringify(typeof body === "function" ? body() : body));
	});
}
