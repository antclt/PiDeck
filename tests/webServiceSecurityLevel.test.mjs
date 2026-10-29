import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Web 端 Pi 会话安全等级（issue #445）。
 *
 * 行为契约：
 * - 读取：/api/state 下发 SecurityStore 的投影（等级表 + 会话覆盖），工具规则细节不下发；
 * - 写入：POST /api/sessions/:id/security-level 由服务端校验会话/后端/等级后写存储；
 * - 隔离：DSH 走 runtime 权限预设、ACP 由 agent CLI 自管，两者必须被拒绝。
 */
const { createDefaultSecurityConfig } = loadTsCommonJs("src/shared/types/security.ts");

function fixture(overrides = {}) {
	const config = createDefaultSecurityConfig();
	const sessions = [
		{ id: "session-1", projectId: "project-1", title: "Pi session", status: "idle" },
		{ id: "dsh-1", projectId: "project-1", title: "DSH session", status: "idle", backend: "dsh" },
		{ id: "acp-1", projectId: "project-1", title: "ACP session", status: "idle", backend: "acp" },
	];
	const calls = [];
	const deps = {
		subscribePiEvents: () => () => undefined,
		getSessionIdForAgent: () => undefined,
		listProjects: () => [{ id: "project-1", name: "Project", path: "C:/project" }],
		listCatalogSessions: async () => sessions,
		listSessionRuntimes: () => [],
		listPendingUiRequests: () => [],
		getSecurityConfig: () => config,
		setSessionSecurityLevel: async (sessionId, levelId) => {
			calls.push({ sessionId, levelId });
			if (levelId) config.sessionOverrides[sessionId] = levelId;
			else delete config.sessionOverrides[sessionId];
			return config;
		},
		...overrides,
	};
	return { config, calls, deps };
}

async function withServer(run, overrides = {}) {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	});
	const harness = fixture(overrides);
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ ...harness, baseUrl });
	} finally {
		await manager.stop();
	}
}

test("切换 Pi 会话安全等级：服务端写覆盖并返回裁剪后的投影", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const response = await fetch(`${baseUrl}/api/sessions/session-1/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ levelId: "strict" }),
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.security.enabled, true);
		assert.equal(body.security.defaultLevelId, "off");
		assert.equal(body.security.sessionOverrides["session-1"], "strict");
		assert.deepEqual(
			body.security.levels.map((level) => level.id),
			["off", "standard", "strict"],
		);
		// 投影只下发选择器字段：工具动作/正则/目录边界属于主进程执行契约
		const strict = body.security.levels.find((level) => level.id === "strict");
		assert.equal(strict.name, "严格");
		assert.equal("toolActions" in strict, false);
		assert.equal("denyBashPatterns" in strict, false);
		assert.deepEqual(calls, [{ sessionId: "session-1", levelId: "strict" }]);
	});
});

test("恢复全局默认：levelId=null 清除会话覆盖", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		await fetch(`${baseUrl}/api/sessions/session-1/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ levelId: "standard" }),
		});
		const response = await fetch(`${baseUrl}/api/sessions/session-1/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ levelId: null }),
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.security.sessionOverrides["session-1"], undefined);
		assert.deepEqual(calls.at(-1), { sessionId: "session-1", levelId: null });
	});
});

test("缺少 levelId 的请求被拒绝（不能把空请求当成清除覆盖）", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const response = await fetch(`${baseUrl}/api/sessions/session-1/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(response.status, 400);
		assert.equal(calls.length, 0);
	});
});

test("未知等级被拒绝且不写存储", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const response = await fetch(`${baseUrl}/api/sessions/session-1/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ levelId: "does-not-exist" }),
		});
		assert.equal(response.status, 400);
		assert.equal(calls.length, 0);
	});
});

test("DSH/ACP 会话不走 pi 安全等级（两套机制隔离）", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		for (const sessionId of ["dsh-1", "acp-1"]) {
			const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/security-level`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ levelId: "strict" }),
			});
			assert.equal(response.status, 400, sessionId);
		}
		assert.equal(calls.length, 0);
	});
});

test("未知会话返回 404", async () => {
	await withServer(async ({ baseUrl, calls }) => {
		const response = await fetch(`${baseUrl}/api/sessions/missing/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ levelId: "strict" }),
		});
		assert.equal(response.status, 404);
		assert.equal(calls.length, 0);
	});
});

test("/api/state 下发安全投影（含会话覆盖），桌面端与 Web 端同一数据源", async () => {
	await withServer(async ({ baseUrl }) => {
		await fetch(`${baseUrl}/api/sessions/session-1/security-level`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ levelId: "standard" }),
		});
		const state = await (await fetch(`${baseUrl}/api/state`)).json();
		assert.equal(state.security.enabled, true);
		assert.equal(state.security.defaultLevelId, "off");
		assert.equal(state.security.sessionOverrides["session-1"], "standard");
		assert.equal(state.security.levels.length, 3);
	});
});
