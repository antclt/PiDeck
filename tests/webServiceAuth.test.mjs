import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadWebServiceModule() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch },
	});
}

async function withManager(host, run, requiresAuth) {
	const { WebServiceManager } = loadWebServiceModule();
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
	});
	await manager.start(host, 0, requiresAuth);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ manager, baseUrl });
	} finally {
		await manager.stop();
	}
}

test("normalizeWebHost trims whitespace and unwraps IPv6 brackets", () => {
	const { normalizeWebHost } = loadWebServiceModule();
	assert.equal(normalizeWebHost("[::1]"), "::1");
	assert.equal(normalizeWebHost("  0.0.0.0 "), "0.0.0.0");
	assert.equal(normalizeWebHost(""), "0.0.0.0");
	assert.equal(normalizeWebHost("[2001:db8::1]"), "2001:db8::1");
	assert.equal(normalizeWebHost("  "), "0.0.0.0");
	assert.equal(normalizeWebHost("localhost"), "localhost");
});

test("non-loopback binding rejects /api without a valid token", async () => {
	await withManager("0.0.0.0", async ({ manager, baseUrl }) => {
		const token = manager.current.token;
		assert.equal(typeof token, "string");
		assert.ok(token.length > 0, "token must be generated on start");
		assert.equal(manager.current.requiresAuth, true);

		// 未带令牌 → 401
		let response = await fetch(`${baseUrl}/api/nope`);
		assert.equal(response.status, 401);
		// 错误令牌（query）→ 401
		response = await fetch(`${baseUrl}/api/nope?token=wrong`);
		assert.equal(response.status, 401);
		// 错误令牌（Bearer）→ 401
		response = await fetch(`${baseUrl}/api/nope`, {
			headers: { authorization: "Bearer wrong" },
		});
		assert.equal(response.status, 401);
		// 正确令牌（query）→ 越过鉴权门，落到 404 apiNotFound
		response = await fetch(`${baseUrl}/api/nope?token=${encodeURIComponent(token)}`);
		assert.equal(response.status, 404);
		// 正确令牌（Bearer）→ 404
		response = await fetch(`${baseUrl}/api/nope`, {
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(response.status, 404);
		// /api/health 探活保持无鉴权
		response = await fetch(`${baseUrl}/api/health`);
		assert.equal(response.status, 200);
	});
});

test("loopback binding with auth disabled stays tokenless", async () => {
	await withManager(
		"127.0.0.1",
		async ({ manager, baseUrl }) => {
			assert.equal(manager.current.requiresAuth, false);
			const response = await fetch(`${baseUrl}/api/nope`);
			assert.equal(response.status, 404);
		},
		false,
	);
});

test("loopback binding with auth enabled requires a valid token", async () => {
	await withManager(
		"127.0.0.1",
		async ({ manager, baseUrl }) => {
			const token = manager.current.token;
			assert.equal(manager.current.requiresAuth, true);

			let response = await fetch(`${baseUrl}/api/nope`);
			assert.equal(response.status, 401);

			response = await fetch(`${baseUrl}/api/nope?token=${encodeURIComponent(token)}`);
			assert.equal(response.status, 404);

			response = await fetch(`${baseUrl}/api/nope`, {
				headers: { authorization: `Bearer ${token}` },
			});
			assert.equal(response.status, 404);

			response = await fetch(`${baseUrl}/api/health`);
			assert.equal(response.status, 200);
		},
		true,
	);
});

test("token is regenerated on every start", async () => {
	const { WebServiceManager } = loadWebServiceModule();
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
	});
	await manager.start("0.0.0.0", 0, false);
	const first = manager.current.token;
	await manager.stop();
	await manager.start("0.0.0.0", 0, false);
	const second = manager.current.token;
	try {
		assert.notEqual(first, second);
	} finally {
		await manager.stop();
	}
});

function loadBrowserApi(fetchImpl, localStorageStub) {
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		fetch: fetchImpl,
		URLSearchParams,
		crypto: globalThis.crypto,
		window: {
			setInterval: () => 1,
			clearInterval: () => undefined,
			location: { search: "" },
			localStorage: localStorageStub,
		},
		require: (specifier) => {
			if (specifier === "./i18n") return { t: (key) => key };
			if (specifier === "./previewApi") {
				return {
					createPreviewApi: () => ({
						projects: { list: async () => [] },
						sessions: { list: async () => [] },
						settings: { get: async () => ({ webServiceEnabled: false }) },
					}),
				};
			}
			throw new Error(`Unexpected browser API dependency: ${specifier}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "browserApi.ts" });
	return sandbox.exports.createBrowserApi;
}

test("web client sends stored token as Bearer header on every request", async () => {
	const seenHeaders = [];
	const fetchImpl = async (_path, init) => {
		seenHeaders.push(init?.headers ?? {});
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				projects: [],
				sessions: [],
				runtimes: [],
				messagesBySession: {},
			}),
		};
	};
	const createBrowserApi = loadBrowserApi(fetchImpl, {
		getItem: (key) => (key === "pideck-web-token" ? "tok-1" : null),
		setItem: () => undefined,
	});
	const api = createBrowserApi();
	await api.projects.list();
	assert.ok(
		seenHeaders.some((headers) => headers.authorization === "Bearer tok-1"),
		"request() must attach Authorization: Bearer <stored token>",
	);
});

test("IPv6 bracketed host is normalized and enforces auth when enabled", async () => {
	const { WebServiceManager } = loadWebServiceModule();
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
	});
	// 先裸 start 取可用端口，再走 applySettings 验证方括号 host 被清洗。
	await manager.start("127.0.0.1", 0, true);
	const port = manager.current.port;
	try {
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "[::1]",
			webServicePort: port,
			webServiceRequiresAuth: true,
		});
		const status = manager.getStatus();
		assert.equal(status.running, true);
		assert.equal(status.host, "::1");
		assert.equal(status.requiresAuth, true);
		const baseUrl = `http://[::1]:${status.port}`;
		let response = await fetch(`${baseUrl}/api/nope`);
		assert.equal(response.status, 401);
		response = await fetch(`${baseUrl}/api/nope?token=${encodeURIComponent(status.token)}`);
		assert.equal(response.status, 404);
		response = await fetch(`${baseUrl}/api/health`);
		assert.equal(response.status, 200);
	} finally {
		await manager.stop();
	}
});

test("toggling requiresAuth alone restarts the service", async () => {
	const { WebServiceManager } = loadWebServiceModule();
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
	});
	// 先裸 start 取可用端口，再走 applySettings 验证仅切换 requiresAuth 会触发重启。
	await manager.start("127.0.0.1", 0, true);
	const port = manager.current.port;
	const firstToken = manager.current.token;
	try {
		let response = await fetch(`http://127.0.0.1:${port}/api/nope`);
		assert.equal(response.status, 401);

		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "127.0.0.1",
			webServicePort: port,
			webServiceRequiresAuth: false,
		});
		assert.equal(manager.getStatus().requiresAuth, false);
		assert.notEqual(manager.current.token, firstToken, "token must be regenerated after restart");
		response = await fetch(`http://127.0.0.1:${port}/api/nope`);
		assert.equal(response.status, 404);
	} finally {
		await manager.stop();
	}
});

test("getStatus reports running shape and clears after stop", async () => {
	await withManager(
		"0.0.0.0",
		async ({ manager }) => {
			const status = manager.getStatus();
			assert.equal(status.running, true);
			assert.equal(status.host, "0.0.0.0");
			assert.equal(typeof status.port, "number");
			assert.equal(typeof status.token, "string");
			assert.equal(status.requiresAuth, true);
		},
		true,
	);
	// withManager 的 finally 已 stop；此处验证 stop 后的形状
	const { WebServiceManager } = loadWebServiceModule();
	const manager = new WebServiceManager({ subscribePiEvents: () => () => undefined });
	await manager.start("127.0.0.1", 0, false);
	await manager.stop();
	// loadTsCommonJs 在独立 vm 域编译，对象原型不同，deepStrictEqual 按原型判等会误报，逐字段断言。
	const stopped = manager.getStatus();
	assert.deepEqual(Object.keys(stopped).sort(), ["host", "port", "requiresAuth", "running", "token"]);
	assert.equal(stopped.running, false);
	assert.equal(stopped.host, "");
	assert.equal(stopped.port, 0);
	assert.equal(stopped.token, "");
	assert.equal(stopped.requiresAuth, false);
});

test("web:status channel is wired across shared ipc, main handler and preload", () => {
	const sharedIpc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(sharedIpc, /webServiceStatus:\s*"web:status"/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.webServiceStatus/);
	assert.match(preload, /ipcChannels\.webServiceStatus/);
});

// ── 裁决 F1：默认分发 web.html 客户端（webApi.ts / WebChatApp.tsx）的令牌通路 ──

function loadWebApi(fetchImpl, windowStub) {
	const source = readFileSync("src/renderer/src/web/webApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		fetch: fetchImpl,
		URLSearchParams,
		window: windowStub,
		require: () => {
			throw new Error("webApi.ts should not need runtime requires (type-only imports)");
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "webApi.ts" });
	return sandbox.exports;
}

function jsonResponse(body) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => body,
	};
}

test("webApi attaches stored token as Bearer to every request", async () => {
	const seen = [];
	const fetchImpl = async (path, init) => {
		seen.push({ path, headers: init?.headers ?? {} });
		return jsonResponse({ models: [], dynamic: [], static: [] });
	};
	const webApi = loadWebApi(fetchImpl, {
		location: { search: "" },
		localStorage: {
			getItem: (key) => (key === "pideck-web-token" ? "tok-web" : null),
			setItem: () => undefined,
		},
	});
	await webApi.fetchModels();
	await webApi.respondToUi({
		sessionId: "s1",
		requestId: "r1",
		agentId: "a1",
		runtimeGeneration: 1,
		response: { type: "text", text: "ok" },
	});
	assert.equal(seen.length, 2);
	assert.ok(
		seen.every(({ headers }) => headers.authorization === "Bearer tok-web"),
		"every webApi request must attach Authorization: Bearer <stored token>",
	);
});

test("webApi captures ?token= URL parameter, persists it, and uses it as Bearer", async () => {
	const stored = new Map();
	const seen = [];
	const fetchImpl = async (_path, init) => {
		seen.push({ headers: init?.headers ?? {} });
		return jsonResponse({ models: [] });
	};
	const webApi = loadWebApi(fetchImpl, {
		location: { search: "?token=from-url" },
		localStorage: {
			getItem: (key) => stored.get(key) ?? null,
			setItem: (key, value) => stored.set(key, value),
		},
	});
	assert.equal(stored.get("pideck-web-token"), "from-url");
	await webApi.fetchModels();
	assert.equal(seen[0].headers.authorization, "Bearer from-url");
});

test("WebChatApp DefaultChatTransport carries token headers", () => {
	const source = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(source, /new DefaultChatTransport\(\{[^}]*headers/);
	assert.match(source, /getWebAuthHeaders/);
});

test("web client persists token from ?token= URL parameter", async () => {
	const stored = [];
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(
		outputText,
		{
			exports: {},
			fetch: async () => {
				throw new Error("not expected");
			},
			URLSearchParams,
			window: {
				setInterval: () => 1,
				clearInterval: () => undefined,
				location: { search: "?token=from-url" },
				localStorage: {
					getItem: () => null,
					setItem: (key, value) => stored.push([key, value]),
				},
			},
			require: (specifier) => {
				if (specifier === "./i18n") return { t: (key) => key };
				if (specifier === "./previewApi") return { createPreviewApi: () => ({}) };
				throw new Error(`Unexpected browser API dependency: ${specifier}`);
			},
		},
		{ filename: "browserApi.ts" },
	);
	assert.deepEqual(stored, [["pideck-web-token", "from-url"]]);
});
