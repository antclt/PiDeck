import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectDshEvent } = loadTsCommonJs("src/main/dsh/dshEventProjector.ts");

const AGENT = "dsh:session-test";

/** 构造 SessionEvent：{ type, seq, time, data }（与 DSH 实测形状一致）。 */
const event = (type, seq, data = {}) => ({ type, seq, time: 1700000000000 + seq, data });

test("user/message 投影为 user 消息（内容块 text 提取）", () => {
	const p = projectDshEvent(undefined, event("user/message", 1, {
		content: [{ type: "text", text: "你好" }],
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:1");
	assert.equal(p.messages[0].agentId, AGENT);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "你好");
	assert.equal(p.messages[0].timestamp, 1700000000001);
	assert.equal(p.messagesChanged, true);
	assert.equal(p.turnEnded, false);
});

test("user/message source.kind=user（带 rpcId）正常投影", () => {
	const p = projectDshEvent(undefined, event("user/message", 2, {
		content: [{ type: "text", text: "真实消息" }],
		source: { kind: "user", rpcId: "rpc-1" },
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "真实消息");
});

test("user/message 工作区上下文注入（source.kind=agent-instructions）不投影", () => {
	// DSH 会把 AGENTS.md / runtime context / skills 清单作为 user/message 注入会话，
	// 投影器必须按 source.kind 过滤，否则时间线出现「发一条消息冒出多条用户消息」。
	const p = projectDshEvent(undefined, event("user/message", 3, {
		content: [{ type: "text", text: "<system-reminder>AGENTS.md 内容…" }],
		source: { kind: "agent-instructions", form: "instructions", baseline: true },
	}), AGENT);
	assert.equal(p.messages.length, 0);
	assert.equal(p.messagesChanged, false);
	assert.equal(p.stateChanged, false);
});

test("user/message 其他系统注入（source.kind=plugin）不投影", () => {
	const p = projectDshEvent(undefined, event("user/message", 4, {
		content: [{ type: "text", text: "插件注入" }],
		source: { kind: "plugin", plugin: "dsh-something" },
	}), AGENT);
	assert.equal(p.messages.length, 0);
	assert.equal(p.messagesChanged, false);
});

test("user/message 无 source 字段（旧会话迁移数据）保守投影", () => {
	// pre-react-loop steering/message 迁移出的 user/message 没有 source，
	// 不能因为字段缺失把真实用户消息丢掉。
	const p = projectDshEvent(undefined, event("user/message", 5, {
		content: [{ type: "text", text: "迁移消息" }],
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "迁移消息");
});

test("assistant/chunk text-delta 累积进 pending 并给出 deltaText 信号", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "收到" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "收到");
	assert.equal(p.deltaText, "收到");
	assert.equal(p.isStreaming, true);
	assert.equal(p.stateChanged, true);
	p = projectDshEvent(p, event("assistant/chunk", 4, {
		chunk: { type: "text-delta", index: 0, text: "。" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "收到。");
	assert.equal(p.messages.length, 0, "delta 阶段不产生消息数组变更");
});

test("assistant/chunk reasoning-delta 累积思考并给 deltaReasoning 信号", () => {
	const p = projectDshEvent(undefined, event("assistant/chunk", 3, {
		chunk: { type: "reasoning-delta", index: 0, text: "思考中" },
	}), AGENT);
	assert.equal(p.pendingAssistantThinking, "思考中");
	assert.equal(p.deltaReasoning, "思考中");
});

test("assistant/message 以终态内容块为准生成 assistant 消息（text/reasoning 分离）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "旧" },
	}), AGENT);
	p = projectDshEvent(p, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "reasoning", reasoning: "内部推理" },
				{ type: "text", text: "今天是星期五。" },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "assistant");
	assert.equal(p.messages[0].text, "今天是星期五。");
	assert.equal(p.messages[0].thinking, "内部推理");
	assert.equal(p.messages[0].stopReason, "stop");
	assert.equal(p.pendingAssistantText, "");
	assert.equal(p.isStreaming, false);
});

test("tool/call 与 tool/result 投影工具消息（结果拼到工具行）", () => {
	let p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "tool");
	assert.equal(p.messages[0].text, "pwsh");
	assert.equal(p.executingTool, "pwsh");

	p = projectDshEvent(p, event("tool/result", 7, {
		message: {
			content: [{ type: "text", text: "C:\\work" }],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.match(p.messages[0].text, /pwsh: C:/);
	assert.equal(p.executingTool, undefined);
});

test("turn/end 正常结束：清 pending、置 turnEnded、无错误消息", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "答" },
	}), AGENT);
	p = projectDshEvent(p, event("turn/end", 8, { reason: { kind: "completed" } }), AGENT);
	assert.equal(p.turnEnded, true);
	assert.equal(p.isStreaming, false);
	assert.equal(p.pendingAssistantText, "");
	assert.equal(p.messages.length, 0);
});

test("turn/end 错误结束：追加 error 消息（如 MISSING_CREDENTIAL）", () => {
	const p = projectDshEvent(undefined, event("turn/end", 8, {
		reason: { kind: "error", error: { message: "no API key" } },
	}), AGENT);
	assert.equal(p.turnEnded, true);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "error");
	assert.equal(p.messages[0].text, "no API key");
});

test("request/context 记录模型路由", () => {
	const p = projectDshEvent(undefined, event("request/context", 9, {
		provider: "opencode-go",
		model: "deepseek-v4-flash",
	}), AGENT);
	assert.equal(p.model?.provider, "opencode-go");
	assert.equal(p.model?.model, "deepseek-v4-flash");
	assert.equal(p.stateChanged, true);
});

test("无关事件不产生任何信号", () => {
	const p = projectDshEvent(undefined, event("session/title", 10, { title: "t" }), AGENT);
	assert.equal(p.messagesChanged, false);
	assert.equal(p.stateChanged, false);
	assert.equal(p.turnEnded, false);
	assert.equal(p.deltaText, undefined);
});
