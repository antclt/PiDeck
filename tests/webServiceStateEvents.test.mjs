import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// /api/events：状态 SSE 端点（替代 Web 端 1s/3s fetchState 轮询的主通道）。
// 只测该端点的行为契约：初始快照、pi 事件去抖推送、快照未变不推、stop 关连接。
function loadWebServiceManager() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	}).WebServiceManager;
}

/** 可变状态夹具：pi 事件推送的快照比对需要一个能改出差异的 sessions 源。 */
function fixture(overrides = {}) {
	let piHandler = null;
	let sessionUpdatedAt = 1;
	const project = { id: "project-1", name: "Project", path: "C:/project" };
	const session = {
		id: "session-1",
		projectId: "project-1",
		title: "Session 1",
		source: "pi",
		environment: "native",
		preview: "",
		messageCount: 0,
		status: "draft",
		createdAt: 1,
		updatedAt: sessionUpdatedAt,
	};
	const runtime = {
		sessionId: session.id,
		agentId: "agent-1",
		runtimeGeneration: 1,
		projectId: session.projectId,
		cwd: "C:/project",
		status: "idle",
		createdAt: 2,
	};
	const deps = {
		subscribePiEvents: (handler) => {
			piHandler = handler;
			return () => {
				piHandler = null;
			};
		},
		getSessionIdForAgent: () => "session-1",
		listProjects: () => [project],
		listAgents: () => [],
		listModels: async () => [],
		listSessions: async () => [session],
		listCatalogSessions: async () => [{ ...session, updatedAt: sessionUpdatedAt }],
		listSessionRuntimes: () => [runtime],
		listPendingUiRequests: () => [],
		...overrides,
	};
	return {
		deps,
		get piHandler() {
			return piHandler;
		},
		bumpSession: () => {
			sessionUpdatedAt += 1;
		},
		setRuntimeStatus: (status) => {
			runtime.status = status;
		},
	};
}

/** SSE 流读取器：增量解码 + 事件解析；next() 超时返回 null（用于「不应再推」断言）。 */
function createEventReader(response) {
	const decoder = new TextDecoder();
	let buffer = "";
	let done = false;
	const pending = [];
	const waiters = [];
	const pump = async () => {
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { value, done: streamDone } = await reader.read();
				if (streamDone) break;
				buffer += decoder.decode(value, { stream: true });
				let separatorIndex;
				while ((separatorIndex = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, separatorIndex);
					buffer = buffer.slice(separatorIndex + 2);
					const name = /^event: (.+)$/m.exec(block)?.[1];
					const data = /^data: (.+)$/m.exec(block)?.[1];
					if (!name) continue; // 注释行（: ping / : service stopping）
					const event = { name, data: data ?? "" };
					const waiter = waiters.shift();
					if (waiter) waiter.resolve(event);
					else pending.push(event);
				}
			}
		} catch {
			// 连接被服务端关闭（stop() 路径）：读循环抛错/结束都视为流终止
		}
		done = true;
		while (waiters.length > 0) waiters.shift().resolve(null);
	};
	void pump();
	return {
		next: (timeoutMs) =>
			new Promise((resolve) => {
				if (pending.length > 0) {
					resolve(pending.shift());
					return;
				}
				if (done) {
					resolve(null);
					return;
				}
				const waiter = { resolve };
				waiters.push(waiter);
				setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					resolve(null);
				}, timeoutMs);
			}),
		isDone: () => done,
	};
}

test("/api/events pushes the initial state snapshot immediately", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/events`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
		const reader = createEventReader(response);
		const first = await reader.next(2000);
		assert.ok(first, "initial snapshot event must arrive");
		assert.equal(first.name, "state");
		const payload = JSON.parse(first.data);
		assert.equal(payload.sessions[0].id, "session-1");
		assert.equal(payload.projects[0].id, "project-1");
		assert.ok(Array.isArray(payload.runtimes));
		await response.body.cancel().catch(() => undefined);
	} finally {
		await manager.stop();
	}
});

test("/api/events pushes on pi events after debounce and skips unchanged snapshots", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/events`);
		const reader = createEventReader(response);
		const initial = await reader.next(2000);
		assert.ok(initial, "initial snapshot");
		const initialPayload = JSON.parse(initial.data);

		// pi 事件 + 快照变化：400ms 去抖后必须推送新快照
		harness.bumpSession();
		harness.setRuntimeStatus("running");
		assert.equal(typeof harness.piHandler, "function");
		harness.piHandler("agent-1", { type: "message_start", sessionId: "session-1" });
		const updated = await reader.next(2500);
		assert.ok(updated, "changed snapshot must be pushed after pi event");
		assert.equal(updated.name, "state");
		const updatedPayload = JSON.parse(updated.data);
		assert.ok(updatedPayload.sessions[0].updatedAt > initialPayload.sessions[0].updatedAt);
		assert.equal(updatedPayload.runtimes[0].status, "running");

		// pi 事件但快照未变：不得再推（去抖窗口 + 一致性免推）
		harness.piHandler("agent-1", { type: "message_delta", sessionId: "session-1" });
		assert.equal(await reader.next(1500), null, "unchanged snapshot must not be pushed");

		await response.body.cancel().catch(() => undefined);
	} finally {
		await manager.stop();
	}
});

test("/api/events connections are closed when the service stops", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	let response;
	try {
		response = await fetch(`http://127.0.0.1:${manager.current.port}/api/events`);
		const reader = createEventReader(response);
		assert.ok(await reader.next(2000), "initial snapshot");
	} finally {
		await manager.stop();
	}
	// stop() 后连接必须终止（closeAllConnections）：后续读取要么 done 要么抛错
	const deadline = Date.now() + 3000;
	for (;;) {
		try {
			const chunk = await response.body.getReader().read();
			if (chunk.done) break;
		} catch {
			break;
		}
		if (Date.now() > deadline) assert.fail("connection must be closed by manager.stop()");
	}
});

test("/api/state stays available as polling fallback alongside /api/events", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/state`);
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.sessions[0].id, "session-1");
	} finally {
		await manager.stop();
	}
});

test("/api/state 返回 ETag 并支持 304（#442：manager 必须转发 extraHeaders）", async () => {
	// 路由层早就算出 etag 了，但装配层 `sendJson: (response, body) => …` 把第三参丢掉，
	// 于是 stateEtag / ifNoneMatchHits 是死代码。这条用例走真 manager，钉住接线。
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const url = `http://127.0.0.1:${manager.current.port}/api/state`;
		const first = await fetch(url);
		assert.equal(first.status, 200);
		const etag = first.headers.get("etag");
		assert.ok(etag, "响应必须带 ETag，否则客户端无从条件请求");
		assert.equal(first.headers.get("cache-control"), "no-cache", "no-store 与 ETag 冲突：客户端无权留存副本，条件请求永远命中不了");
		await first.text();

		const second = await fetch(url, { headers: { "if-none-match": etag } });
		assert.equal(second.status, 304, "ETag 未变必须 304");
		assert.equal(await second.text(), "", "304 不能带响应体");
		assert.equal(second.headers.get("etag"), etag);
	} finally {
		await manager.stop();
	}
});

test("5s 兜底 tick 推送不进版本键的会话目录变更（#442）", async () => {
	// 桌面端改名/删除会话只改会话目录，runtime 与 pendingUi 不动 → stateRevision 不变。
	// 修复前 5s tick 与 pi 事件共用同一道版本键门，第一道就 return，客户端 18s 都收不到 state。
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/events`);
		const reader = createEventReader(response);
		const initial = await reader.next(2000);
		assert.ok(initial, "initial snapshot");
		const initialUpdatedAt = JSON.parse(initial.data).sessions[0].updatedAt;

		// 只改会话目录，不触发任何 pi 事件：唯一能把它推出去的路径就是 5s tick
		harness.bumpSession();
		const pushed = await reader.next(7000);
		assert.ok(pushed, "目录变更必须由 5s 兜底 tick 推出（版本键不含会话目录）");
		assert.equal(pushed.name, "state");
		assert.ok(JSON.parse(pushed.data).sessions[0].updatedAt > initialUpdatedAt);

		await response.body.cancel().catch(() => undefined);
	} finally {
		await manager.stop();
	}
});
