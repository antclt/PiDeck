import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshAgentManager } = loadTsCommonJs("src/main/dsh/DshAgentManager.ts");

/**
 * 假 DSH host：内存 session 注册表 + 可注入的 history 事件。
 * DshAgentManager 只依赖 DshHost 的 ensureStarted/getClient（InProcessApiClient），
 * 这里用同形状的假 client（sessions.list/create/history + events.mux 空流）。
 */
function makeFakeHost() {
	const sessions = new Map();
	let nextSession = 0;
	const historyBySession = new Map();
	const calls = { create: 0, list: 0, history: 0, fork: 0, prompt: 0 };
	const promptCalls = [];
	const client = {
		sessions: {			async list() {
				calls.list += 1;
				return { result: { ok: true, value: { items: [...sessions.values()] } } };
			},
			async create({ cwd }) {
				calls.create += 1;
				const sessionId = `session-fake-${++nextSession}`;
				const summary = { sessionId, cwd, running: false, blank: true };
				sessions.set(sessionId, summary);
				return { result: { ok: true, value: summary } };
			},
			async history({ sessionId, beforeSeq, maxMessages }) {
				calls.history += 1;
				const log = historyBySession.get(sessionId) ?? [];
				// 与 DSH 官方 pageOf 同语义：end = beforeSeq 缺失时取末尾（排除边界，
				// 返回 seq < beforeSeq 的事件）；从 end 往前数 maxMessages 条消息，
				// 在最近一个 turn/start 处切页；hasMore = 起点之前还有事件。
				const end = beforeSeq === undefined ? log.length : Math.max(0, Math.min(beforeSeq, log.length));
				let start = 0;
				let messages = 0;
				for (let i = end - 1; i >= 0; i -= 1) {
					const item = log[i];
					if (item?.type === "user/message" || item?.type === "assistant/message") messages += 1;
					if (item?.type === "turn/start" && messages >= maxMessages) {
						start = i;
						break;
					}
				}
				return {
					result: {
						ok: true,
						value: {
							events: log.slice(start, end).map((entry) => ({ event: entry })),
							hasMore: start > 0,
						},
					},
				};
			},
			async prompt({ content }) {
				calls.prompt += 1;
				promptCalls.push(content?.[0]?.text ?? "");
				return { result: { ok: true, value: { accepted: true } } };
			},
			async cancel() {
				return { result: { ok: true, value: {} } };
			},
			async rename({ title }) {
				return { result: { ok: true, value: { title } } };
			},
			async models() {
				return { result: { ok: true, value: { groups: [] } } };
			},
			async selectModel({ provider, model }) {
				return { result: { ok: true, value: { selected: { provider, model } } } };
			},
			async fork({ sessionId, atSeq }) {
				calls.fork += 1;
				// 模拟 fork：生成新 sessionId，并把 atSeq 前的历史带过去
				const newId = `session-forked-${sessionId}-${atSeq}`;
				sessions.set(newId, { sessionId: newId, cwd: PROJECT.path, running: false, blank: false });
				const source = historyBySession.get(sessionId) ?? [];
				historyBySession.set(newId, source.filter((item) => (item.seq ?? 0) <= atSeq));
				return { result: { ok: true, value: { sessionId: newId } } };
			},
		},
		events: {
			async *mux() {
				// 空事件流：测试不关心实时事件，只验证 create 路径本身。
				return;
			},
		},
		llm: {
			async models() {
				return { result: { ok: true, value: { groups: [] } } };
			},
		},
	};
	const host = {
		async ensureStarted() {},
		getClient() {
			return client;
		},
	};
	return { host, client, sessions, historyBySession, calls, promptCalls };
}

const PROJECT = { id: "project-1", path: "C:\\work" };

/** 构造与 DSH 实测一致的 SessionEvent。 */
const event = (type, seq, data = {}) => ({ type, seq, time: 1700000000000 + seq, data });

test("create 新建 DSH 会话并注册 runtime（无 dshSessionId 时）", async () => {
	const { host, client, calls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	assert.equal(calls.create, 1);
	assert.match(tab.id, /^dsh:session-fake-/);
	assert.equal(tab.backend, "dsh");
	assert.equal(manager.list().length, 1);
	assert.equal(manager.getMessages(tab.id).length, 0, "新建会话无历史");
});

test("create 带 dshSessionId 且 host 存在该会话：attach 不新建", async () => {
	const { host, sessions, historyBySession, calls } = makeFakeHost();
	// 预置 host 里已存在的会话（模拟上次运行创建、本次重启后 attach）
	sessions.set("session-old-1", { sessionId: "session-old-1", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-old-1", [
		event("user/message", 1, {
			content: [{ type: "text", text: "上一轮的提问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("turn/start", 2),
		event("assistant/message", 3, {
			message: { content: [{ type: "text", text: "上一轮的回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-old-1" });
	assert.equal(calls.create, 0, "attach 路径不得新建 host 会话");
	assert.equal(tab.id, "dsh:session-old-1");
	// 历史尾部被投影为初始消息（真实对话可见）
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[0].text, "上一轮的提问");
	assert.equal(messages[1].role, "assistant");
	assert.equal(messages[1].text, "上一轮的回复");
	assert.equal(calls.history, 1);
});

test("create 带 dshSessionId 但 host 已无该会话：退回新建", async () => {
	const { host, calls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-gone-9",
	});
	assert.equal(calls.create, 1, "host 找不到持久化 id 时必须新建");
	assert.notEqual(tab.id, "dsh:session-gone-9");
	assert.equal(manager.getMessages(tab.id).length, 0);
});

test("create attach 历史投影过滤注入上下文（source.kind=agent-instructions 不上屏）", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-old-2", { sessionId: "session-old-2", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-old-2", [
		event("user/message", 1, {
			content: [{ type: "text", text: "提问" }],
			source: { kind: "user", rpcId: "rpc-2" },
		}),
		// 工作区上下文注入：不应出现在时间线
		event("user/message", 2, {
			content: [{ type: "text", text: "<system-reminder>AGENTS.md…" }],
			source: { kind: "agent-instructions", form: "instructions", baseline: true },
		}),
		event("assistant/message", 3, {
			message: { content: [{ type: "text", text: "回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-old-2" });
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 2, "注入上下文不得投影为用户消息");
	assert.equal(messages[0].text, "提问");
	assert.equal(messages[1].text, "回复");
	assert.equal(messages[0].role, "user");
	assert.equal(messages[1].role, "assistant");
});

test("readHistoryPage 对齐渲染层 disk 分页协议（seq 游标、hasMore 边界）", async () => {
	const { host, sessions, historyBySession, calls } = makeFakeHost();
	sessions.set("session-hist-1", { sessionId: "session-hist-1", cwd: PROJECT.path, running: false, blank: false });
	// 4 轮对话（turn/start + user + assistant），seq 1..12：
	//   [1 turn/start, 2 问1, 3 答1] [4 turn/start, 5 问2, 6 答2]
	//   [7 turn/start, 8 问3, 9 答3] [10 turn/start, 11 问4, 12 答4]
	const history = [];
	const turns = [
		[1, 2, 3],
		[4, 5, 6],
		[7, 8, 9],
		[10, 11, 12],
	];
	for (const [turnSeq, userSeq, assistantSeq] of turns) {
		history.push(event("turn/start", turnSeq));
		history.push(event("user/message", userSeq, {
			content: [{ type: "text", text: `问${userSeq}` }],
			source: { kind: "user", rpcId: `rpc-${userSeq}` },
		}));
		history.push(event("assistant/message", assistantSeq, {
			message: { content: [{ type: "text", text: `答${assistantSeq}` }] },
		}));
	}
	historyBySession.set("session-hist-1", history);
	const manager = new DshAgentManager(host, () => PROJECT);
	// 首页：beforeSeq undefined → 尾部 4 条消息（问8 答9 问11 答12，seq 7..12）
	const page1 = await manager.readHistoryPage("session-hist-1", undefined, 4);
	assert.equal(page1.messages.length, 4);
	assert.equal(page1.messages[0].text, "问8");
	assert.equal(page1.messages[3].text, "答12");
	assert.equal(typeof page1.nextBefore, "number", "还有更早历史时 nextBefore 是数字游标");
	assert.equal(page1.total, -1, "DSH 无总条数概念，返回 -1 占位");
	// 翻页：beforeSeq = 本页最旧事件 seq（排除边界，seq < beforeSeq 的事件）
	const page2 = await manager.readHistoryPage("session-hist-1", page1.nextBefore, 4);
	assert.equal(page2.messages.length, 4);
	assert.equal(page2.messages[0].text, "问2");
	assert.equal(page2.messages[3].text, "答6");
	assert.equal(page2.nextBefore, null, "8 条消息两页取尽，到尾页 hasMore=false → nextBefore=null");
	assert.equal(calls.history, 2);
});

test("readHistoryPage 空会话返回空页且 nextBefore=null", async () => {
	const { host, sessions } = makeFakeHost();
	sessions.set("session-empty", { sessionId: "session-empty", cwd: PROJECT.path, running: false, blank: true });
	const manager = new DshAgentManager(host, () => PROJECT);
	const page = await manager.readHistoryPage("session-empty", undefined, 100);
	assert.equal(page.messages.length, 0);
	assert.equal(page.nextBefore, null);
	assert.equal(page.total, -1);
});

test("getForkMessages 收集用户消息并以 seq 编码 entryId", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-fork-src", { sessionId: "session-fork-src", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-fork-src", [
		event("turn/start", 1),
		event("user/message", 2, {
			content: [{ type: "text", text: "第一问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("assistant/message", 3, { message: { content: [{ type: "text", text: "答1" }] } }),
		event("turn/start", 4),
		event("user/message", 5, {
			content: [{ type: "text", text: "第二问" }],
			source: { kind: "user", rpcId: "rpc-2" },
		}),
		event("assistant/message", 6, { message: { content: [{ type: "text", text: "答2" }] } }),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-fork-src" });
	const forkMessages = await manager.getForkMessages(tab.id);
	assert.equal(forkMessages.length, 2);
	assert.equal(forkMessages[0].entryId, "seq:2");
	assert.equal(forkMessages[0].text, "第一问");
	assert.equal(forkMessages[1].entryId, "seq:5");
	assert.equal(forkMessages[1].text, "第二问");
});

test("forkSession 在 atSeq 裁剪出新会话并换绑 runtime", async () => {
	const { host, sessions, historyBySession, calls } = makeFakeHost();
	sessions.set("session-fork-src", { sessionId: "session-fork-src", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-fork-src", [
		event("turn/start", 1),
		event("user/message", 2, {
			content: [{ type: "text", text: "第一问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("assistant/message", 3, { message: { content: [{ type: "text", text: "答1" }] } }),
		event("turn/start", 4),
		event("user/message", 5, {
			content: [{ type: "text", text: "第二问" }],
			source: { kind: "user", rpcId: "rpc-2" },
		}),
		event("assistant/message", 6, { message: { content: [{ type: "text", text: "答2" }] } }),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-fork-src" });
	assert.equal(tab.sessionId, "session-fork-src");

	// 从「第一问」(seq:2) fork：新会话只带 seq ≤ 2 的历史
	const result = await manager.forkSession(tab.id, "seq:2");
	assert.equal(calls.fork, 1);
	assert.equal(result.text, "第一问", "fork 返回被 fork 的用户消息文本（渲染层预填输入框）");
	// runtime 换绑：agentId 不变，sessionId 指向新 fork 会话
	const newTab = manager.list().find((candidate) => candidate.id === tab.id);
	assert.ok(newTab, "fork 后 agentId 保持存在");
	assert.notEqual(newTab.sessionId, "session-fork-src");
	assert.match(newTab.sessionId, /^session-forked-/);
	// 新会话历史 = fork 点前内容（seq 1..2）
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].text, "第一问");
	// 旧会话不再被 runtime 持有（可从 catalog 重新打开）
	assert.equal(manager.list().length, 1);
});

test("forkSession 拒绝非法 entryId", async () => {
	const { host, sessions } = makeFakeHost();
	sessions.set("session-fork-bad", { sessionId: "session-fork-bad", cwd: PROJECT.path, running: false, blank: true });
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-fork-bad" });
	await assert.rejects(() => manager.forkSession(tab.id, "not-a-seq"));
	await assert.rejects(() => manager.forkSession(tab.id, "seq:abc"));
});

test("compact 以 /compact 提示词触发 host 命令并返回 runtime state", async () => {
	const { host, sessions, calls, promptCalls } = makeFakeHost();
	sessions.set("session-compact", { sessionId: "session-compact", cwd: PROJECT.path, running: false, blank: false });
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-compact" });
	const state = await manager.compact(tab.id);
	assert.equal(calls.prompt, 1);
	assert.equal(promptCalls[0], "/compact", "无参 compact 发送裸 /compact");
	assert.equal(state.isStreaming, false);
	// 带参 compact：/compact <prompt>
	await manager.compact(tab.id, "keep focus on refactor");
	assert.equal(calls.prompt, 2);
	assert.equal(promptCalls[1], "/compact keep focus on refactor");
});

test("capabilities 声明 fork/getForkMessages/compact 且不含 pi 专属能力", () => {
	const { host, sessions } = makeFakeHost();
	sessions.set("session-cap", { sessionId: "session-cap", cwd: PROJECT.path, running: false, blank: true });
	const manager = new DshAgentManager(host, () => PROJECT);
	const caps = manager.capabilities;
	assert.ok(caps.has("fork"));
	assert.ok(caps.has("getForkMessages"));
	assert.ok(caps.has("compact"));
	assert.ok(!caps.has("editMessage"), "DSH 不支持编辑历史消息");
	assert.ok(!caps.has("deleteMessage"));
	assert.ok(!caps.has("getCommands"));
	assert.ok(!caps.has("exportHtml"));
});
