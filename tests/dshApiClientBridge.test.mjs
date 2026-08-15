import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// vm 沙箱默认没有 fetch 系全局（主进程有，测试需补齐）：
// DshApiClient 用 Headers/Response/ReadableStream/DOMException 组装标准 Response。
const { DshApiClient } = loadTsCommonJs("src/main/dsh/DshApiClient.ts", {
  globals: {
    Headers,
    Response,
    ReadableStream,
    DOMException,
    TextEncoder,
  },
});

/**
 * 内存 transport：模拟 utilityProcess 桥两侧。
 * - mainToHost: main 发出的消息（fetch-request/abort）
 * - hostPush: 测试侧主动向 client 推送 host → main 消息（response/chunk/end/error）
 */
function makeMemoryTransport() {
	const mainToHost = [];
	const listeners = new Set();
	return {
		transport: {
			send(message) {
				mainToHost.push(message);
			},
			onMessage(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose() {
				listeners.clear();
			},
		},
		mainToHost,
		hostPush(message) {
			for (const listener of listeners) listener(message);
		},
	};
}

/** loadModule：真实 import 官方 apiproxy 包（ESM-only，Node 22 下可动态 import）。 */
async function loadModule() {
	return import("@deepseek-ai/dsh-host-apiproxy");
}

/** 轮询等待 mainToHost 出现消息（官方客户端链在 microtask 里推进，不依赖固定延时）。 */
async function waitForOutbound(mainToHost, count = 1, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (mainToHost.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return mainToHost.length >= count;
}

test("unary 请求：fetch-request 发出，fetch-response 组装为 Response", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();

	// 用官方领域方法发 unary（callUnary → postJson → doFetch）
	const promise = api.sessions.list({});
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].type, "fetch-request");
	assert.equal(mainToHost[0].path, "/api/session.list");

	// host 回 unary 响应：完整四象限信封（callUnary 校验 type=server-response +
	// rpcId 回显——rpcId 在 fetch-request 的 body 里（client-request 信封），
	// 桥消息的 id 只是传输关联键，不是协议 rpcId）。
	const requestId = mainToHost[0].id;
	const requestBody = JSON.parse(mainToHost[0].body);
	hostPush({
		type: "fetch-response",
		id: requestId,
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "server-response",
			rpcId: requestBody.rpcId,
			result: { ok: true, value: { items: [] } },
		}),
	});
	const result = await promise;
	assert.equal(result.result.ok, true);
	client.dispose();
});

test("unary 非 ok 响应抛 transport failure（与官方 postJson 契约一致）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const promise = api.sessions.list({});
	await waitForOutbound(mainToHost, 1);
	const requestId = mainToHost[0].id;
	hostPush({ type: "fetch-response", id: requestId, status: 500, body: "boom" });
	await assert.rejects(promise, /transport failure/);
	client.dispose();
});

test("SSE 流：stream-start → chunk* → end 组装为可读流", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();

	// events.mux 是 async generator（readSse）：惰性执行，先 next() 触发 fetch
	const iterator = api.events.mux({}, new AbortController().signal);
	const pending = iterator.next();
	await waitForOutbound(mainToHost, 1);
	assert.equal(mainToHost[0].path, "/api/events.mux");
	const requestId = mainToHost[0].id;

	hostPush({ type: "fetch-stream-start", id: requestId, status: 200 });
	// 两帧 SSE：外层是 server-request 信封（readSse 先 parse 信封），
	// payload 是 mux 帧（session/event：sessionId + event）
	const muxFrame1 = {
		type: "session/event",
		sessionId: "session-s1",
		event: { type: "turn/start", seq: 1, time: 1, data: {} },
	};
	const muxFrame2 = {
		type: "session/event",
		sessionId: "session-s1",
		event: { type: "assistant/message", seq: 2, time: 2, data: { message: { content: [{ type: "text", text: "hi" }] } } },
	};
	const sseLine1 = JSON.stringify({ type: "server-request", rpcId: "rpc-1", method: "events.mux", payload: muxFrame1 });
	const sseLine2 = JSON.stringify({ type: "server-request", rpcId: "rpc-2", method: "events.mux", payload: muxFrame2 });
	hostPush({ type: "fetch-chunk", id: requestId, data: `data: ${sseLine1}\n\n` });
	hostPush({ type: "fetch-chunk", id: requestId, data: `data: ${sseLine2}\n\n` });
	hostPush({ type: "fetch-end", id: requestId });

	const frames = [];
	// 第一个 next() 已在 pending 里（返回首帧），继续迭代收完
	frames.push((await pending).value);
	for await (const frame of iterator) frames.push(frame);
	assert.equal(frames.length, 2);
	assert.equal(frames[0].rpcId, "rpc-1");
	assert.equal(frames[0].payload.type, "session/event");
	assert.equal(frames[1].payload.event.type, "assistant/message");
	client.dispose();
});

test("SSE 流跨 chunk 边界：帧被拆到两条消息仍正确组装", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const iterator = api.events.mux({}, new AbortController().signal);
	const pending = iterator.next();
	await waitForOutbound(mainToHost, 1);
	const requestId = mainToHost[0].id;

	hostPush({ type: "fetch-stream-start", id: requestId, status: 200 });
	const envelope = {
		type: "server-request",
		rpcId: "rpc-split",
		method: "events.mux",
		payload: {
			type: "session/event",
			sessionId: "session-s1",
			event: { type: "user/message", seq: 3, time: 3, data: { content: [{ type: "text", text: "hi" }] } },
		},
	};
	const data = `data: ${JSON.stringify(envelope)}\n\n`;
	// 拆成两个 chunk：前一半 + 后一半
	hostPush({ type: "fetch-chunk", id: requestId, data: data.slice(0, 20) });
	hostPush({ type: "fetch-chunk", id: requestId, data: data.slice(20) });
	hostPush({ type: "fetch-end", id: requestId });

	const frames = [];
	frames.push((await pending).value);
	for await (const frame of iterator) frames.push(frame);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].rpcId, "rpc-split");
	client.dispose();
});

test("fetch-error 使流 reject", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const iterator = api.events.mux({}, new AbortController().signal);
	const pending = iterator.next();
	await waitForOutbound(mainToHost, 1);
	const requestId = mainToHost[0].id;
	hostPush({ type: "fetch-stream-start", id: requestId, status: 200 });
	hostPush({ type: "fetch-error", id: requestId, message: "host stream died" });

	const seen = [];
	try {
		seen.push((await pending).value);
		for await (const frame of iterator) seen.push(frame);
	} catch (error) {
		assert.match(String(error), /host stream died/);
		return;
	}
	assert.fail("流应 reject");
	client.dispose();
});

test("外部 abort 转发 fetch-abort 并 reject", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const controller = new AbortController();
	// 先挂 catch（abort 可能在任何 await 点触发，避免 PromiseRejectionHandledWarning 竞态）
	const promise = api.sessions.list({}, controller.signal).catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	controller.abort();
	// abort 转发：main → host 的 fetch-abort 已发出
	assert.ok(
		mainToHost.some((message) => message.type === "fetch-abort"),
		"abort 必须转发 fetch-abort 到 host",
	);
	// 官方 callUnary 的 abort 契约：promise reject
	const error = await promise;
	assert.match(String(error), /aborted/);
	client.dispose();
});

test("dispose 拒绝在途请求并退订", async () => {
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const promise = api.sessions.list({}).catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	client.dispose();
	const error = await promise;
	assert.match(String(error), /transport disposed/);
});

test("dispose 后 abort/新请求不再向 transport 发消息", async () => {
	// 回归：旧实现 dispose 后 abort 回调仍调用 transport.send，而 host 进程已退出时
	// postMessage 会 throw（日志里 "DSH host process is not running" 崩溃即由此而来）。
	const { transport, mainToHost } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const controller = new AbortController();
	const promise = api.sessions.list({}, controller.signal).catch(() => undefined);
	await waitForOutbound(mainToHost, 1);
	client.dispose();
	const before = mainToHost.length;
	controller.abort();
	// abort 发生在 dispose 之后：不能再发 fetch-abort（transport 已死）
	assert.equal(mainToHost.length, before, "dispose 后 abort 不得向 transport 发消息");
	await promise;
	// dispose 后新请求直接 reject，不产生任何桥消息
	const after = mainToHost.length;
	const late = await api.sessions.list({}).catch((error) => error);
	assert.match(String(late), /transport disposed/);
	assert.equal(mainToHost.length, after, "dispose 后新请求不得向 transport 发消息");
});



test("abortAllPending 中断悬挂流（host 进程退出联动：mux 无 fetch-end 时不再永久悬挂）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	// mux 流已建立但 host 侧永远不会发 fetch-end（进程崩溃场景）
	const iterator = api.events.mux({}, new AbortController().signal);
	const pending = iterator.next().catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	const requestId = mainToHost[0].id;
	hostPush({ type: "fetch-stream-start", id: requestId, status: 200 });
	// DshHost 的 exit 联动：abortAllPending 应让悬挂流以 error 结束（pump 据此退避重连）
	client.abortAllPending();
	const error = await pending;
	assert.match(String(error), /DSH host process exited/);
	client.dispose();
});

test("abortAllPending 后新请求不受影响（仅中断当时在途的流）", async () => {
	const { transport, mainToHost, hostPush } = makeMemoryTransport();
	const client = new DshApiClient({ transport, loadModule });
	const api = await client.getClient();
	const iterator = api.events.mux({}, new AbortController().signal);
	const pending = iterator.next().catch((error) => error);
	await waitForOutbound(mainToHost, 1);
	const requestId = mainToHost[0].id;
	hostPush({ type: "fetch-stream-start", id: requestId, status: 200 });
	client.abortAllPending();
	await pending;
	// 新 mux 订阅（重启完成后）：应正常建立并接收帧
	const iterator2 = api.events.mux({}, new AbortController().signal);
	const pending2 = iterator2.next();
	await waitForOutbound(mainToHost, 2);
	const requestId2 = mainToHost[1].id;
	hostPush({ type: "fetch-stream-start", id: requestId2, status: 200 });
	// 注意：readSse 会按 zod schema 校验帧，event 必须带 time/data，否则整帧被 drop。
	const frame = {
		type: "server-request",
		rpcId: "rpc-9",
		method: "events.mux",
		payload: {
			type: "session/event",
			sessionId: "s1",
			event: { type: "turn/start", seq: 1, time: 1, data: {} },
		},
	};
	hostPush({ type: "fetch-chunk", id: requestId2, data: `data: ${JSON.stringify(frame)}\n\n` });
	// readSse 解析信封后 yield { rpcId, payload }。
	assert.deepEqual((await pending2).value, { rpcId: "rpc-9", payload: frame.payload });
	client.dispose();
});
