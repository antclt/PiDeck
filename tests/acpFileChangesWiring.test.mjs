import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * ACP 会话的文件修改聚合契约。
 *
 * 背景（审计发现 I）：ACP 工具卡片由 AcpEventProjector 产出 meta.toolName + meta.args=rawInput，
 * 与 pi 的 tool 消息同构，因此 shared/fileChanges 的聚合逻辑对两者通用。
 *
 * 2027-02 变更：`sessionsListFileChanges` 这条会话级 IPC（含它的 ACP 分支装配）已随
 * 「右侧面板文件 tab + Web 文件条」一并下线，文件修改改由每轮末尾的 chip 行
 * （turn/TurnFileChanges → collectRunFileChanges）展示。因此本文件只保留**行为面**契约：
 * ACP 工具卡片仍然能被聚合出文件修改——否则轮末 chip 行对 ACP 会话会是空的。
 */

test("ACP 工具卡片消息可被 collectSessionFileChanges 聚合（meta.toolName/meta.args 契约）", () => {
	const { collectSessionFileChanges } = loadTsCommonJs("src/shared/fileChanges.ts");
	const acpEdit = { role: "assistant", text: "edit", meta: { toolName: "edit", toolCallId: "t1", args: { filePath: "C:/repo/a.ts", oldText: "a", newText: "b" } } };
	const acpWrite = { role: "assistant", text: "write", meta: { toolName: "write", toolCallId: "t2", args: { filePath: "C:/repo/new.ts", content: "hi" } } };
	const entries = collectSessionFileChanges([acpEdit, acpWrite]);
	assert.equal(entries.length, 2);
	assert.deepEqual([...entries.map((entry) => entry.path)], ["C:/repo/a.ts", "C:/repo/new.ts"]);
	assert.equal(entries[0].originalContent, "a");
	assert.equal(entries[0].content, "b");
});

test("ACP 工具卡片能被轮末 chip 行的按轮聚合复用（collectRunFileChanges）", () => {
	const { collectRunFileChanges } = loadTsCommonJs("src/renderer/src/components/session/TimelineFormat.ts");
	// 一轮 run 内混入 ACP 的 edit/write 与一条非文件工具：只有文件类进入结果
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 1,
		endedAt: 2,
		items: [
			{ kind: "message", message: { role: "user", id: "u1", text: "hi", timestamp: 1 } },
			{
				kind: "tool-group",
				id: "tg-1",
				messages: [
					{ role: "assistant", text: "edit", meta: { toolName: "edit", toolCallId: "t1", args: { filePath: "C:/repo/a.ts", oldText: "a", newText: "b" } } },
					{ role: "assistant", text: "bash", meta: { toolName: "bash", toolCallId: "t2", args: { command: "ls" } } },
				],
			},
		],
	};
	const files = collectRunFileChanges(run);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "C:/repo/a.ts");
});

test("ACP content diff 经投影后可直接被 collectSessionFileChanges 聚合（不依赖 rawInput 形状）", () => {
	const { initialAcpProjection, projectAcpSessionUpdate } = loadTsCommonJs("src/main/acp/AcpEventProjector.ts");
	const { collectSessionFileChanges } = loadTsCommonJs("src/shared/fileChanges.ts");
	// agent 只把改动放 content（规范路径），标题也不是英文 edit/write：
	// 投影层必须归一成 pi/DSH 同形的 toolName=edit + {filePath,oldText,newText}。
	const state = projectAcpSessionUpdate(
		initialAcpProjection(),
		{
			sessionUpdate: "tool_call",
			toolCallId: "tc-diff",
			title: "修改文件",
			status: "completed",
			content: [{ type: "diff", path: "C:/repo/a.ts", oldValue: "a", newValue: "b" }],
		},
		"agent-1",
	);
	const entries = collectSessionFileChanges(state.messages);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].path, "C:/repo/a.ts");
	assert.equal(entries[0].originalContent, "a");
	assert.equal(entries[0].content, "b");
});

test("ACP 只上报 file_path 的编辑（Qoder 实测 kind=edit）也进本轮文件清单，且不产生虚假 diff", () => {
	const { initialAcpProjection, projectAcpSessionUpdate } = loadTsCommonJs("src/main/acp/AcpEventProjector.ts");
	const { collectSessionFileChanges, getToolDiffTarget, hasFileChangePayload } = loadTsCommonJs("src/shared/fileChanges.ts");
	// Qoder CLI 的 wire 实际形态：title=Edit、kind=edit，rawInput 只有 file_path，
	// content 为空数组（旧/新文本根本不上 wire）。修复前聚合结果恒为空 → 轮末 chip 行消失。
	let state = projectAcpSessionUpdate(
		initialAcpProjection(),
		{ sessionUpdate: "tool_call", toolCallId: "tc-path", title: "Edit", kind: "edit", status: "in_progress", rawInput: { file_path: "C:/repo/a.ts" } },
		"agent-1",
	);
	state = projectAcpSessionUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "tc-path", status: "completed", content: [] }, "agent-1");
	const entries = collectSessionFileChanges(state.messages);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].path, "C:/repo/a.ts");
	assert.equal(entries[0].count, 1);
	// 空载荷：工具卡不渲染空 diff、chip 不显示 +0/−0，点击退回打开文件。
	assert.equal(hasFileChangePayload(getToolDiffTarget(state.messages[0])), false);
});

test("非编辑类工具即使带 file_path 也不进文件清单（kind=read）", () => {
	const { initialAcpProjection, projectAcpSessionUpdate } = loadTsCommonJs("src/main/acp/AcpEventProjector.ts");
	const { collectSessionFileChanges } = loadTsCommonJs("src/shared/fileChanges.ts");
	const state = projectAcpSessionUpdate(initialAcpProjection(), { sessionUpdate: "tool_call", toolCallId: "tc-read", title: "Read File", kind: "read", status: "completed", rawInput: { file_path: "C:/repo/a.ts" } }, "agent-1");
	assert.equal(collectSessionFileChanges(state.messages).length, 0);
});

test("同一文件先有 diff 再有只路径编辑：保留先前 diff 载荷，只累计次数", () => {
	const { collectSessionFileChanges } = loadTsCommonJs("src/shared/fileChanges.ts");
	const entries = collectSessionFileChanges([
		{ role: "tool", text: "edit", meta: { toolName: "edit", kind: "edit", args: { filePath: "C:/repo/a.ts", oldText: "a", newText: "b" } } },
		{ role: "tool", text: "Edit", meta: { toolName: "Edit", kind: "edit", args: { file_path: "C:/repo/a.ts" } } },
	]);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].count, 2);
	assert.equal(entries[0].originalContent, "a");
	assert.equal(entries[0].content, "b");
});
