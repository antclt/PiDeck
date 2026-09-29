import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { CuaApprovalServer } = loadTsCommonJs("src/main/cua/CuaApprovalServer.ts");

test("CuaApprovalServer starts and returns a port", async () => {
	const server = new CuaApprovalServer(
		{ port: 0 },
		{
			requestApproval: async () => ({ allowed: true }),
		},
	);

	const port = await server.start();
	assert.ok(port > 0);
	assert.strictEqual(server.getPort(), port);
	assert.ok(server.getUrl()?.startsWith("http://127.0.0.1:"));

	await server.stop();
});

test("CuaApprovalServer handles valid approval request", async () => {
	let receivedApproval = null;

	const server = new CuaApprovalServer(
		{ port: 0, timeoutMs: 5000 },
		{
			requestApproval: async (approval) => {
				receivedApproval = approval;
				return { allowed: true };
			},
		},
	);

	await server.start();
	const url = server.getUrl();

	const response = await fetch(`${url}/cua-approve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			action: "click",
			sessionId: "sess1",
			detail: { x: 100, y: 200 },
			timestampMs: Date.now(),
		}),
	});

	assert.strictEqual(response.status, 200);
	const result = await response.json();
	assert.strictEqual(result.allowed, true);
	assert.strictEqual(receivedApproval.action, "click");
	assert.strictEqual(receivedApproval.sessionId, "sess1");

	await server.stop();
});

test("CuaApprovalServer returns denial from handler", async () => {
	const server = new CuaApprovalServer(
		{ port: 0, timeoutMs: 5000 },
		{
			requestApproval: async () => ({ allowed: false, reason: "user_denied" }),
		},
	);

	await server.start();
	const url = server.getUrl();

	const response = await fetch(`${url}/cua-approve`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			action: "type",
			sessionId: "sess1",
			detail: { text: "hello" },
			timestampMs: Date.now(),
		}),
	});

	const result = await response.json();
	assert.strictEqual(result.allowed, false);
	assert.strictEqual(result.reason, "user_denied");

	await server.stop();
});

test("CuaApprovalServer returns 404 for unknown paths", async () => {
	const server = new CuaApprovalServer({ port: 0 }, { requestApproval: async () => ({ allowed: true }) });

	await server.start();
	const url = server.getUrl();

	const response = await fetch(`${url}/unknown`, { method: "POST" });
	assert.strictEqual(response.status, 404);

	await server.stop();
});

test("CuaApprovalServer stop is idempotent", async () => {
	const server = new CuaApprovalServer({ port: 0 }, { requestApproval: async () => ({ allowed: true }) });

	await server.start();
	await server.stop();
	await server.stop(); // Should not throw.
});

test("getPort returns 0 before start", () => {
	const server = new CuaApprovalServer({ port: 0 }, { requestApproval: async () => ({ allowed: true }) });
	assert.strictEqual(server.getPort(), 0);
	assert.strictEqual(server.getUrl(), null);
});
