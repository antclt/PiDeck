import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归 issue #435：workspace 路由（/api/files、/api/prompts、/api/skills、/api/extensions、
 * /api/git/*）自己 writeHead，漏了 Access-Control-Allow-Origin。浏览器规则是「预检通过、
 * 实际响应缺 CORS 头 → 丢弃响应并抛 TypeError: Failed to fetch」，所以跨域客户端 100% 失败。
 *
 * 这里直接构造真 WebWorkspaceRoutes，喂假 deps + 假 ServerResponse，断言每个出口都带 CORS，
 * 并断言预检放行 authorization（否则跨域 POST 的 Bearer 无路可走）。
 */
const { WebWorkspaceRoutes } = loadTsCommonJs("src/main/web/WebWorkspaceRoutes.ts");
const { sendNoContent, sendError, sendJson } = loadTsCommonJs("src/main/web/WebHttpResponders.ts");

function createResponse() {
	const captured = { headersSent: false, headers: undefined, status: undefined, body: undefined };
	const response = {
		get headersSent() {
			return captured.headersSent;
		},
		req: { headers: {} },
		writeHead(status, headers) {
			captured.headersSent = true;
			captured.status = status;
			captured.headers = headers;
			return response;
		},
		end(payload) {
			captured.body = payload;
		},
	};
	return { captured, response };
}

function createRoutes(overrides = {}) {
	return new WebWorkspaceRoutes({
		listProjects: () => [{ id: "p1", path: process.cwd(), name: "repo" }],
		files: { listTree: async () => [] },
		prompts: { list: async () => ({ categories: [], prompts: [], total: 0 }), detail: async () => null },
		assets: {
			listSkills: async () => ({ locations: [], skills: [] }),
			toggleSkill: async () => ({}),
			listExtensions: async () => ({ extensions: [], conflicts: [] }),
			setExtensionEnabled: async () => {},
		},
		...overrides,
	});
}

async function call(handle, path) {
	const { captured, response } = createResponse();
	const handled = await handle(new URL(`http://127.0.0.1:8765${path}`), { method: "GET" }, response);
	return { handled, ...captured };
}

test("/api/files 实际响应带 CORS 头", async () => {
	const routes = createRoutes();
	const result = await call((url, request, response) => routes.handle(url, request, response), "/api/files?projectId=p1");
	assert.equal(result.handled, true);
	assert.equal(result.status, 200);
	assert.equal(result.headers["access-control-allow-origin"], "*");
});

test("workspace 路由的错误响应同样带 CORS 头（否则客户端只看到 Failed to fetch，看不到 404）", async () => {
	const routes = createRoutes();
	const result = await call((url, request, response) => routes.handle(url, request, response), "/api/files?projectId=missing");
	assert.equal(result.status, 404);
	assert.equal(result.headers["access-control-allow-origin"], "*");
});

test("/api/prompts、/api/skills、/api/extensions、/api/git/status 均带 CORS 头", async () => {
	const routes = createRoutes({
		git: {
			isGitRepo: async () => false,
			getBranches: async () => ({}),
			getStatus: async () => ({}),
			getWorkspaceFileDiff: async () => null,
			getCommitLog: async () => [],
		},
	});
	const paths = ["/api/prompts", "/api/skills", "/api/extensions", "/api/git/status?projectId=p1"];
	for (const path of paths) {
		const result = await call((url, request, response) => routes.handle(url, request, response), path);
		assert.equal(result.status, 200, `${path} 应 200`);
		assert.equal(result.headers["access-control-allow-origin"], "*", `${path} 缺 CORS 头`);
	}
});

test("预检放行 authorization，跨域 POST 才能带 Bearer", () => {
	const { captured, response } = createResponse();
	sendNoContent(response);
	assert.equal(captured.headers["access-control-allow-headers"], "content-type, authorization");
	assert.equal(captured.headers["access-control-allow-origin"], "*");
});

test("主路由出口（sendJson/sendError）与 workspace 出口共用同一套 CORS 常量", () => {
	const json = createResponse();
	sendJson(json.response, { ok: true });
	const error = createResponse();
	sendError(error.response, 400, "webError.invalidRequest", "bad");
	assert.equal(json.captured.headers["access-control-allow-origin"], "*");
	assert.equal(error.captured.headers["access-control-allow-origin"], "*");
});
