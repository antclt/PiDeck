import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { gunzipSync } from "node:zlib";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// /api/state 载荷治理（Web 走查 #6/#7）：
//  - #6 会话按 Web 可见字段投影，桌面端专用字段（filePath/environment/preview/
//    messageCount/dshSessionId/agentPreset）不下发；
//  - #7 大响应按 accept-encoding 走 gzip，未声明/小响应保持明文。
// 只测行为契约：从 HTTP 边界断言，不依赖内部字段名。

/** 起一个真 server（与 webServiceBodyLimit 同装配），跑完即停。 */
async function withServer(run, { sessionCount = 1 } = {}) {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", { globals: { fetch: globalThis.fetch } });
	const session = {
		id: "session-1",
		projectId: "project-1",
		title: "Session 1",
		source: "pi",
		environment: "native",
		filePath: "C:/sessions/session-1.jsonl",
		preview: "preview text",
		messageCount: 12,
		status: "active",
		model: { provider: "deepseek", modelId: "deepseek-flash" },
		thinkingLevel: "low",
		permissionPreset: "workspace-write",
		dshSessionId: "dsh-1",
		agentPreset: "standard",
		createdAt: 1,
		updatedAt: 2,
	};
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		listProjects: () => [{ id: "project-1", name: "Project", path: "C:/project" }],
		listCatalogSessions: async () => Array.from({ length: sessionCount }, (_, index) => (index === 0 ? session : { ...session, id: `session-${index + 1}`, title: `Session ${index + 1}` })),
		listSessionRuntimes: () => [{ sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1, status: "idle", cwd: "C:/project", projectId: "project-1", createdAt: 3 }],
		listPendingUiRequests: () => [],
	});
	await manager.start("127.0.0.1", 0, false);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ baseUrl });
	} finally {
		await manager.stop();
	}
}

/** 原始 HTTP GET：Node fetch 会自动解 gzip 并剥掉 content-encoding，看不出服务端是否真压了。 */
function rawGet(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = http.get(url, { headers }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
		});
		request.on("error", reject);
	});
}

test("state sessions are projected to the web-visible field set", async () => {
	await withServer(async ({ baseUrl }) => {
		const { body } = await rawGet(`${baseUrl}/api/state`);
		const state = JSON.parse(body.toString("utf8"));
		assert.equal(state.sessions.length, 1);
		const session = state.sessions[0];
		// 保留：渲染层读取的字段
		assert.deepEqual(
			{ id: session.id, projectId: session.projectId, title: session.title, status: session.status, updatedAt: session.updatedAt, permissionPreset: session.permissionPreset },
			{ id: "session-1", projectId: "project-1", title: "Session 1", status: "active", updatedAt: 2, permissionPreset: "workspace-write" },
		);
		// 裁剪：Web 端零消费的桌面端专用字段
		for (const dropped of ["filePath", "environment", "preview", "messageCount", "dshSessionId", "agentPreset", "source"]) {
			assert.equal(dropped in session, false, `${dropped} must not be sent to the web client`);
		}
	});
});

test("large JSON responses are gzipped when the client asks for it", async () => {
	// 400 条会话 → 快照远超 8KB 压缩阈值（单条会话的 state 太小，压了反而亏）
	await withServer(
		async ({ baseUrl }) => {
			const big = await rawGet(`${baseUrl}/api/state`, { "accept-encoding": "gzip" });
			const plain = await rawGet(`${baseUrl}/api/state`);
			assert.equal(big.headers["content-encoding"], "gzip");
			assert.equal(plain.headers["content-encoding"], undefined);
			assert.equal(big.headers.vary, "accept-encoding");
			// 压缩后必须能还原成同一份快照
			const decompressed = JSON.parse(gunzipSync(big.body).toString("utf8"));
			assert.deepEqual(decompressed, JSON.parse(plain.body.toString("utf8")));
			assert.ok(big.body.byteLength < plain.body.byteLength, "gzipped body must be smaller");
		},
		{ sessionCount: 400 },
	);
});

test("gzip is skipped for small payloads and for q=0 clients", async () => {
	await withServer(
		async ({ baseUrl }) => {
			const small = await rawGet(`${baseUrl}/api/sessions/runtimes`, { "accept-encoding": "gzip" });
			assert.equal(small.headers["content-encoding"], undefined, "tiny payloads are not worth a 6ms gzip round");
			// q=0 显式拒绝 gzip：即便载荷够大也必须明文
			const refused = await rawGet(`${baseUrl}/api/state`, { "accept-encoding": "gzip;q=0, identity" });
			assert.equal(refused.headers["content-encoding"], undefined);
		},
		{ sessionCount: 400 },
	);
});
