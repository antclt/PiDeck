import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTodoSnapshotData } from "../src/shared/sessionTodo.ts";
import {
	runtimeTodosToItems,
	sessionTodoSnapshotToItems,
} from "../src/renderer/src/components/session/agentTodoParser.ts";

test("parseTodoSnapshotData: version-2 快照解析出计划与待办", () => {
	const snapshot = parseTodoSnapshotData({
		version: 2,
		activePlan: {
			id: 3,
			todos: [
				{ id: 15, text: "主进程读取", done: false },
				{ id: 22, text: "文件 tab", done: true },
			],
		},
		nextPlanId: 4,
		nextTodoId: 27,
	});
	assert.deepEqual(snapshot, {
		planId: 3,
		todos: [
			{ id: 15, text: "主进程读取", done: false },
			{ id: 22, text: "文件 tab", done: true },
		],
	});
});

test("parseTodoSnapshotData: clear 后无 activePlan 返回 undefined", () => {
	assert.equal(parseTodoSnapshotData({ version: 2, nextPlanId: 4, nextTodoId: 5 }), undefined);
});

test("parseTodoSnapshotData: 非对象输入返回 undefined", () => {
	assert.equal(parseTodoSnapshotData(undefined), undefined);
	assert.equal(parseTodoSnapshotData("nope"), undefined);
	assert.equal(parseTodoSnapshotData(null), undefined);
});

test("parseTodoSnapshotData: 坏项丢弃而非整体失败", () => {
	const snapshot = parseTodoSnapshotData({
		activePlan: {
			id: 1,
			todos: [
				{ id: 1, text: "ok", done: true },
				{ text: "no id" },
				{ id: 2, text: "", done: false },
				{ id: "x", text: "string id", done: false },
				"garbage",
				{ id: 3, text: "also ok", done: false },
			],
		},
	});
	assert.deepEqual(snapshot?.todos, [
		{ id: 1, text: "ok", done: true },
		{ id: 3, text: "also ok", done: false },
	]);
});

test("parseTodoSnapshotData: todos 非数组视为空计划", () => {
	assert.deepEqual(parseTodoSnapshotData({ activePlan: { id: 2 } }), { planId: 2, todos: [] });
});

test("sessionTodoSnapshotToItems: 快照转 TodoItem（状态映射与解析口径同 widget 路径）", () => {
	const items = sessionTodoSnapshotToItems({
		planId: 3,
		todos: [
			{ id: 15, text: "主进程读取", done: false },
			{ id: 22, text: "文件 tab", done: true },
		],
	});
	assert.deepEqual(items, [
		{ id: "主进程读取", title: "主进程读取", status: "pending" },
		{ id: "文件 tab", title: "文件 tab", status: "completed" },
	]);
});

test("sessionTodoSnapshotToItems: undefined / 空快照返回空数组", () => {
	assert.deepEqual(sessionTodoSnapshotToItems(undefined), []);
	assert.deepEqual(sessionTodoSnapshotToItems({ planId: 1, todos: [] }), []);
});

test("runtimeTodosToItems: DSH 结构化 todo 保留三态并为重复正文生成稳定 key", () => {
	assert.deepEqual(runtimeTodosToItems([
		{ content: "读取会话", status: "pending" },
		{ content: "读取会话", status: "in_progress" },
		{ content: "补充测试", status: "completed" },
	]), [
		{ id: "读取会话", title: "读取会话", status: "pending" },
		{ id: "读取会话#2", title: "读取会话", status: "in-progress" },
		{ id: "补充测试", title: "补充测试", status: "completed" },
	]);
	assert.deepEqual(runtimeTodosToItems(null), []);
});
