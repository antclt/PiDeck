import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 工具调用 → 待办 / 子代理 的通用推导（ACP 会话的数据源）。
// 报文样本取自本机真实 ACP 归档（CodeBuddy 的 TaskCreate/TaskUpdate、Claude 的 Task），
// 契约：名称归一匹配、同名不同义按参数形状区分、解析不出来就返回空而不是抛。

const { deriveTodoPlan, deriveSubagents, isSubagentToolCall, isSubagentToolName } = loadTsCommonJs(join(process.cwd(), "src/shared/toolActivityDerivation.ts"));

const plain = (value) => JSON.parse(JSON.stringify(value));

/** 工具卡消息的最小形状（与 ACP 投影器产出的 meta 同构）。 */
function toolCard(meta, extra = {}) {
	return { id: meta.toolCallId ?? "m1", role: "tool", timestamp: 1_000, meta: { status: "completed", ...meta }, ...extra };
}

test("deriveTodoPlan：整表工具（TodoWrite / update_plan）直接归一", () => {
	const todos = deriveTodoPlan([
		toolCard({
			toolCallId: "t1",
			toolName: "TodoWrite",
			status: "completed",
			args: {
				todos: [
					{ content: "读代码", status: "completed" },
					{ content: "写兼容层", status: "in_progress" },
					{ content: "跑测试", status: "pending" },
				],
			},
		}),
	]);
	assert.deepEqual(plain(todos), [
		{ content: "读代码", status: "completed" },
		{ content: "写兼容层", status: "in_progress" },
		{ content: "跑测试", status: "pending" },
	]);
});

test("deriveTodoPlan：update_plan 的 step 键与复数容器名也要认", () => {
	const todos = deriveTodoPlan([
		toolCard({
			toolCallId: "t1",
			toolName: "update_plan",
			args: { explanation: "x", plan: [{ step: "改投影器", status: "in_progress" }] },
		}),
	]);
	assert.deepEqual(plain(todos), [{ content: "改投影器", status: "in_progress" }]);
});

test("deriveTodoPlan：TaskCreate/TaskUpdate 增量折叠（真实 CodeBuddy 报文）", () => {
	const todos = deriveTodoPlan([
		toolCard({ toolCallId: "c1", toolName: "TaskCreate", args: { subject: "等待镜像同步 0.1.3", description: "轮询 npmmirror", activeForm: "等待镜像同步" } }),
		toolCard({ toolCallId: "c2", toolName: "TaskCreate", args: { subject: "刷新本地插件安装", description: "保留现有账号" } }),
		toolCard({ toolCallId: "u1", toolName: "TaskUpdate", args: { taskId: "1", status: "in_progress" } }),
		toolCard({ toolCallId: "u2", toolName: "TaskUpdate", args: { taskId: "1", status: "completed" } }),
	]);
	assert.deepEqual(plain(todos), [
		{ content: "等待镜像同步 0.1.3", status: "completed" },
		{ content: "刷新本地插件安装", status: "pending" },
	]);
});

test("deriveTodoPlan：deleted 状态移除条目", () => {
	const todos = deriveTodoPlan([toolCard({ toolCallId: "c1", toolName: "TaskCreate", args: { subject: "A" } }), toolCard({ toolCallId: "c2", toolName: "TaskCreate", args: { subject: "B" } }), toolCard({ toolCallId: "u1", toolName: "TaskUpdate", args: { taskId: "1", status: "deleted" } })]);
	assert.deepEqual(plain(todos), [{ content: "B", status: "pending" }]);
});

test("deriveTodoPlan：后台 shell 任务（TaskOutput / TaskStop）不得混进待办", () => {
	const todos = deriveTodoPlan([toolCard({ toolCallId: "o1", toolName: "TaskOutput", args: { task_id: "Z2w15a", timeout: 180000 } }), toolCard({ toolCallId: "s1", toolName: "TaskStop", args: { task_id: "JjqnJv" } })]);
	assert.deepEqual(plain(todos), []);
});

test("deriveTodoPlan：无工具卡 / 脏载荷返回空且不抛", () => {
	assert.deepEqual(plain(deriveTodoPlan([])), []);
	assert.deepEqual(plain(deriveTodoPlan([{ id: "x", role: "assistant", meta: { toolName: "TodoWrite" } }])), []);
	assert.deepEqual(plain(deriveTodoPlan([{ id: "x", role: "tool" }])), []);
	assert.deepEqual(plain(deriveTodoPlan([toolCard({ toolCallId: "t1", toolName: "TodoWrite", args: { todos: [null, 42, { content: "" }] } })])), []);
});

test("deriveSubagents：Task 工具 → 子代理条目（类型/描述/状态/来源）", () => {
	const entries = deriveSubagents([
		toolCard({
			toolCallId: "task-1",
			toolName: "Task",
			status: "running",
			args: { description: "审查 ACP 时序", subagent_type: "Explore", prompt: "看 #413" },
		}),
	]);
	assert.deepEqual(plain(entries), [{ id: "task-1", type: "Explore", description: "审查 ACP 时序", status: "running", startedAt: 1_000, source: "toolcall" }]);
});

test("deriveSubagents：终态带结果预览，失败落 error", () => {
	const entries = deriveSubagents([
		toolCard({ toolCallId: "a", toolName: "Agent", status: "completed", args: { description: "搜集用法" }, result: { type: "text", text: "报告正文" } }, { timestamp: 1_000 }),
		toolCard({ toolCallId: "b", toolName: "agent", status: "failed", args: { task: "跑构建" }, fullText: "编译失败" }, { timestamp: 2_000 }),
		toolCard({ toolCallId: "c", toolName: "Task", status: "running", args: { description: "还在跑" } }, { timestamp: 500 }),
	]);
	const byId = Object.fromEntries(plain(entries).map((entry) => [entry.id, entry]));
	assert.equal(byId.a.status, "completed");
	assert.equal(byId.a.result, "报告正文");
	assert.equal(byId.a.description, "搜集用法");
	assert.equal(byId.b.status, "error");
	assert.equal(byId.b.error, "编译失败");
	// 运行中/排队置顶，其余按开始时间倒序
	assert.deepEqual(
		plain(entries).map((entry) => entry.id),
		["c", "b", "a"],
	);
});

test("deriveSubagents：title 被写成子代理类型名（真实 CodeBuddy 报文 general-purpose）也能识别", () => {
	// ACP 侧 title 不是 "Task"，而是子代理类型本身；唯一可靠信号是参数的 subagent_type
	const entries = deriveSubagents([
		toolCard({
			toolCallId: "gp-1",
			toolName: "general-purpose",
			kind: "other",
			status: "completed",
			args: { description: "Design review of PiDeck workspace UI", subagent_type: "general-purpose", prompt: "你是设计总监……" },
		}),
	]);
	assert.equal(entries.length, 1);
	assert.deepEqual(plain(entries[0]), {
		id: "gp-1",
		type: "general-purpose",
		description: "Design review of PiDeck workspace UI",
		status: "completed",
		source: "toolcall",
		startedAt: 1_000,
	});
	assert.equal(isSubagentToolCall("general-purpose", { subagent_type: "general-purpose" }), true);
	// 代码模式的 REPL 卡片只在 code 文本里出现 Agent(，不是子代理调用
	assert.equal(isSubagentToolCall("REPL", { code: "const A = Agent({ subagent_type: 'x' })" }), false);
});

test("deriveSubagents：TaskCreate/TaskOutput/查询类工具不是子代理", () => {
	assert.equal(isSubagentToolName("TaskCreate"), false);
	assert.equal(isSubagentToolName("TaskUpdate"), false);
	assert.equal(isSubagentToolName("TaskOutput"), false);
	assert.equal(isSubagentToolName("subagent_inspect"), false);
	assert.equal(isSubagentToolName("subagent_list"), false);
	assert.equal(isSubagentToolName("Task"), true);
	assert.equal(isSubagentToolName("acp_delegate"), true);
	assert.equal(isSubagentToolName("Subagent"), true);
	const entries = deriveSubagents([toolCard({ toolCallId: "c1", toolName: "TaskCreate", args: { subject: "A" } }), toolCard({ toolCallId: "o1", toolName: "TaskOutput", args: { task_id: "x" } })]);
	assert.deepEqual(plain(entries), []);
});

test("deriveSubagents：同 id 重放取最后一次，acp_delegate 标记 via", () => {
	const entries = deriveSubagents([toolCard({ toolCallId: "d1", toolName: "acp_delegate", status: "running", args: { agent: "reviewer", task: "审 #450" } }), toolCard({ toolCallId: "d1", toolName: "acp_delegate", status: "completed", args: { agent: "reviewer", task: "审 #450" } })]);
	assert.equal(entries.length, 1);
	assert.equal(plain(entries[0]).status, "completed");
	assert.equal(plain(entries[0]).via, "acp-delegate");
	assert.equal(plain(entries[0]).type, "reviewer");
});
