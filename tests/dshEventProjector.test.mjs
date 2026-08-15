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

test("assistant/chunk text-delta 累积进 pending 并给出 deltaText 信号（首次增量创建流式骨架）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "收到" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "收到");
	assert.equal(p.deltaText, "收到");
	assert.equal(p.isStreaming, true);
	assert.equal(p.stateChanged, true);
	// 首次增量创建空文本骨架消息（渲染层 interim-answer 挂载点），id = dsh:<delta seq>
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:3");
	assert.equal(p.messages[0].role, "assistant");
	assert.equal(p.messages[0].text, "");
	assert.equal(p.messages[0].stopReason, "pending");
	// 思考开始时间 = 首个增量时间（思考块耗时 endedAt - startedAt）
	assert.equal(p.messages[0].thinkingStartedAt, 1700000000003);
	assert.equal(p.messagesChanged, true);
	p = projectDshEvent(p, event("assistant/chunk", 4, {
		chunk: { type: "text-delta", index: 0, text: "。" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "收到。");
	assert.equal(p.messages.length, 1, "后续增量不再重复创建骨架");
	assert.equal(p.messagesChanged, false);
});

test("assistant/chunk reasoning-delta 累积思考并给 deltaReasoning 信号", () => {
	const p = projectDshEvent(undefined, event("assistant/chunk", 3, {
		chunk: { type: "reasoning-delta", index: 0, text: "思考中" },
	}), AGENT);
	assert.equal(p.pendingAssistantThinking, "思考中");
	assert.equal(p.deltaReasoning, "思考中");
	assert.equal(p.messages.length, 1, "reasoning 增量同样创建骨架");
	assert.equal(p.messages[0].id, "dsh:3");
});

test("assistant/message 以终态内容块为准更新流式骨架（同 id 不 remount）", () => {
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
	// 骨架 id（首个 delta 的 seq）保持不变：渲染层 Live→History 不 remount
	assert.equal(p.messages[0].id, "dsh:3");
	assert.equal(p.messages[0].text, "今天是星期五。");
	assert.equal(p.messages[0].thinking, "内部推理");
	assert.equal(p.messages[0].stopReason, "stop");
	// 思考耗时边界：startedAt 保留骨架创建时间（seq 3），endedAt = 终态事件时间（seq 5）
	assert.equal(p.messages[0].thinkingStartedAt, 1700000000003);
	assert.equal(p.messages[0].thinkingEndedAt, 1700000000005);
	assert.equal(p.pendingAssistantText, "");
	assert.equal(p.isStreaming, false);
});

test("assistant/message 无流式骨架时按终态正常 push（历史重放路径）", () => {
	const p = projectDshEvent(undefined, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "reasoning", reasoning: "内部推理" },
				{ type: "text", text: "完整回答" },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:5");
	assert.equal(p.messages[0].text, "完整回答");
	assert.equal(p.messages[0].thinking, "内部推理");
});

test("assistant/message 只有 tool-call 块（无正文无思考）不落空气泡", () => {
	// 模型直接发起工具调用时，assistant/message 的 content 只含 tool-call 块：
	// 落一条空文本 assistant 消息会让时间线出现空白气泡，终态由 tool/call 卡片承接。
	const p = projectDshEvent(undefined, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "tool-call", id: "call-1", name: "pwsh", arguments: { command: "Get-Location" } },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 0, "纯工具调用不产生 assistant 消息");
	assert.equal(p.pendingAssistantText, "");
	assert.equal(p.pendingAssistantThinking, "");
	assert.equal(p.isStreaming, false);
	assert.equal(p.stateChanged, true);
});

test("assistant/message 工具调用但有流式思考：更新骨架保留 thinking（不丢已渲染内容）", () => {
	// 模型思考后发起工具调用：reasoning-delta 已流式渲染（骨架存在），
	// 终态 content 只含 tool-call 块——必须更新骨架而不是丢弃，
	// 否则时间线上已显示的 Live 思考在终态被清掉。
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "reasoning-delta", index: 0, text: "我先查一下" },
	}), AGENT);
	p = projectDshEvent(p, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "tool-call", id: "call-1", name: "pwsh", arguments: { command: "Get-Location" } },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1, "有流式思考的工具回合保留骨架");
	assert.equal(p.messages[0].id, "dsh:3");
	assert.equal(p.messages[0].text, "");
	// 终态 content 无 reasoning 块：用流式累积兜底（finalThinking = pendingAssistantThinking）
	assert.equal(p.messages[0].thinking, "我先查一下");
	assert.equal(p.pendingAssistantThinking, "");
});

test("text-chunks 打包行：正文增量累积 + 骨架（id 取 seq0）", () => {
	// DSH 持久化把长 run 的 text-delta 打包成 text-chunks 行（{type, seq0, time0, data:{texts}}），
	// mux 与 history 都可能出现——投影器必须消费，否则中间回答不渲染。
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, { type: "text-chunks", seq0: 10, time0: 1700000000010, data: {
		turn: 1, step: 1, index: 0, dt: [0, 1], texts: ["发现", "关键", "线索"],
	} }, AGENT);
	assert.equal(p.pendingAssistantText, "发现关键线索");
	assert.equal(p.deltaText, "发现关键线索");
	assert.equal(p.isStreaming, true);
	assert.equal(p.stateChanged, true);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:10", "骨架 id 取打包行 seq0");
	p = projectDshEvent(p, { type: "text-chunks", seq0: 13, time0: 1700000000013, data: {
		turn: 1, step: 1, index: 0, dt: [], texts: ["了。"],
	} }, AGENT);
	assert.equal(p.pendingAssistantText, "发现关键线索了。");
	assert.equal(p.messages.length, 1, "后续打包行不重复创建骨架");
});

test("reasoning-chunks 打包行：思考增量累积（不重复打包行）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, { type: "reasoning-chunks", seq0: 20, time0: 1700000000020, data: {
		turn: 1, step: 1, index: 0, dt: [1], texts: ["Let me", " think"],
	} }, AGENT);
	assert.equal(p.pendingAssistantThinking, "Let me think");
	assert.equal(p.deltaReasoning, "Let me think");
	assert.equal(p.messages[0].id, "dsh:20");
	// 终态更新骨架：thinking 以终态 content 为准，缺失时用流式累积兜底
	p = projectDshEvent(p, event("assistant/message", 25, {
		message: { content: [{ type: "text", text: "最终回答" }] },
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:20");
	assert.equal(p.messages[0].text, "最终回答");
	assert.equal(p.messages[0].thinking, "Let me think");
});

test("text-chunks 非字符串成员被过滤（防御脏数据）", () => {
	const p = projectDshEvent(undefined, { type: "text-chunks", seq0: 30, time0: 0, data: {
		turn: 1, step: 1, index: 0, dt: [], texts: ["好", 42, null],
	} }, AGENT);
	assert.equal(p.pendingAssistantText, "好");
	assert.equal(p.deltaText, "好");
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
	// status=running 驱动工具卡片旋转动画（getToolStatus 读取 meta.status）
	assert.equal(p.messages[0].meta?.status, "running");

	p = projectDshEvent(p, event("tool/result", 7, {
		message: {
			content: [{ type: "text", text: "C:\\work" }],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.match(p.messages[0].text, /pwsh: C:/);
	// 结果到达：摘掉 running，卡片动画停止（无 running 即 done）
	assert.equal(p.messages[0].meta?.status, "done");
	// 工具耗时 = result 时间 - call 时间（渲染层工具卡片 formatDuration）
	assert.equal(p.messages[0].meta?.durationMs, 1);
	assert.equal(p.executingTool, undefined);
});

test("tool/call 的 arguments（JSON 字符串）解析进 meta.args，host view 透传进 meta.view", () => {
	// DSH 的 tool/call.arguments 是 JSON 字符串（host 侧 presentCall 也 JSON.parse 后消费）；
	// PiDeck 工具卡片的副标题（command/path/pattern/query/url）、详情与 diff 都读 meta.args。
	let p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
		arguments: JSON.stringify({
			command: "Get-Location",
			description: "查看当前目录",
			workdir: "C:\\work",
		}),
	}), AGENT, { for: "call", view: { card: "terminal", title: "Get-Location", description: "查看当前目录" } });
	assert.equal(p.messages.length, 1);
	// loadTsCommonJs 在独立 realm 执行 TS：JSON.parse 产物的原型属于该 realm，
	// deepStrictEqual 跨 realm 恒失败，逐字段断言（行为等价）。
	const args = p.messages[0].meta?.args;
	assert.equal(args?.command, "Get-Location");
	assert.equal(args?.description, "查看当前目录");
	assert.equal(args?.workdir, "C:\\work");
	assert.equal(p.messages[0].meta?.view?.for, "call");
	assert.equal(p.messages[0].meta?.view?.view?.card, "terminal");
});

test("tool/call 的 arguments 非法 JSON 时保留原始字符串（渲染层 parseToolArgs 双兼容）", () => {
	const p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
		arguments: "{not-json",
	}), AGENT);
	assert.equal(p.messages[0].meta?.args, "{not-json");
});

test("turn/end 正常结束：清 pending、置 turnEnded、无错误消息（骨架保留为已流式内容）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "答" },
	}), AGENT);
	p = projectDshEvent(p, event("turn/end", 8, { reason: { kind: "completed" } }), AGENT);
	assert.equal(p.turnEnded, true);
	assert.equal(p.isStreaming, false);
	assert.equal(p.pendingAssistantText, "");
	// 骨架是已入列的 assistant 消息：无 assistant/message 终态时保留已流式内容
	// （渲染层按 stopReason=pending 回退判为最终回答，中断回答不丢失）
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].text, "答");
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

test("permission/preset 事件折叠权限预设（last wins）", () => {
	// 会话创建时 host pin 默认预设（workspace-write）
	let p = projectDshEvent(undefined, event("permission/preset", 1, { preset: "workspace-write" }), AGENT);
	assert.equal(p.permissionPreset, "workspace-write");
	assert.equal(p.stateChanged, true);
	// /permission read-only 切换
	p = projectDshEvent(p, event("permission/preset", 2, { preset: "read-only" }), AGENT);
	assert.equal(p.permissionPreset, "read-only");
	assert.equal(p.stateChanged, true);
	// 同值重复事件不产生状态信号（渲染层避免无谓刷新）
	p = projectDshEvent(p, event("permission/preset", 3, { preset: "read-only" }), AGENT);
	assert.equal(p.stateChanged, false);
	// 空值/非字符串安全忽略
	p = projectDshEvent(p, event("permission/preset", 4, { preset: 42 }), AGENT);
	assert.equal(p.permissionPreset, "read-only");
	assert.equal(p.stateChanged, false);
});

test("plan/mode 事件折叠 plan 状态（last wins，缺省关闭）", () => {
	let p = projectDshEvent(undefined, event("user/message", 1, {
		content: [{ type: "text", text: "hi" }],
		source: { kind: "user", rpcId: "rpc-1" },
	}), AGENT);
	assert.equal(p.planModeActive, false, "无 plan/mode 事件时缺省关闭");
	// /plan 生效
	p = projectDshEvent(p, event("plan/mode", 2, { active: true }), AGENT);
	assert.equal(p.planModeActive, true);
	assert.equal(p.stateChanged, true);
	// /plan off
	p = projectDshEvent(p, event("plan/mode", 3, { active: false }), AGENT);
	assert.equal(p.planModeActive, false);
	// 同值重复不产生信号
	p = projectDshEvent(p, event("plan/mode", 4, { active: false }), AGENT);
	assert.equal(p.stateChanged, false);
});

test("permission/preset 与 plan/mode 不影响消息/回合信号", () => {
	let p = projectDshEvent(undefined, event("permission/preset", 1, { preset: "read-only" }), AGENT);
	p = projectDshEvent(p, event("plan/mode", 2, { active: true }), AGENT);
	assert.equal(p.messagesChanged, false);
	assert.equal(p.turnEnded, false);
	assert.equal(p.messages.length, 0);
});
