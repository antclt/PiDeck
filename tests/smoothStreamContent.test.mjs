import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { stripCodeComments } from "./_sourceContract.mjs";

const SMOOTH = "src/renderer/src/utils/smoothStreamContent.ts";
const HOOK = "src/renderer/src/utils/useSmoothStream.ts";
const { classifySmoothStreamChange, pushGraphemes } = loadTsCommonJs(SMOOTH);

/**
 * 2026-10-27 事故回归：点「展开全文」把预览一次性换成 205KB 全文，useSmoothStream 的
 * append 分支把 delta 切出的十几万 grapheme `push(...chars)` spread 成一次函数调用的实参
 * ——V8 实参个数有引擎上限，直接 RangeError: Maximum call stack size exceeded，
 * passive effect 挂载阶段整树中断，展开按钮点了没反应且控制台报错。
 */

test("pushGraphemes 十万级 grapheme 不爆栈且保序", () => {
	const total = 200_001;
	const chars = Array.from({ length: total }, (unused, index) => String(index % 10));
	const queue = [];

	pushGraphemes(queue, chars);

	assert.equal(queue.length, total, "逐个推入不受实参个数上限约束");
	assert.equal(queue[0], "0");
	assert.equal(queue[total - 1], String((total - 1) % 10), "顺序必须与输入一致（打字机逐字输出）");
});

test("pushGraphemes 空数组是 no-op", () => {
	const queue = ["keep"];
	pushGraphemes(queue, []);
	assert.deepEqual(queue, ["keep"]);
});

test("useSmoothStream 不再含 push spread（事故源头钉死）", () => {
	// 剥注释再断言：修复说明里会写到 push(...chars) 这个反例本身。
	const code = stripCodeComments(readFileSync(HOOK, "utf8"));
	assert.doesNotMatch(code, /\.push\(\.\.\./, "队列入队必须走 pushGraphemes（spread 实参会爆栈）");
	assert.match(code, /pushGraphemes\(chunkQueueRef\.current/, "append 分支必须经 pushGraphemes 入队");
});

test("流已结束的 content 变更不再入队（入队是纯浪费，收口 effect 负责 dump）", () => {
	const code = stripCodeComments(readFileSync(HOOK, "utf8"));
	// delta 入队 effect 是文件里第一个 useEffect，收尾依赖是 [content, disabled]。
	const deltaEffect = code.match(/useEffect\(\(\) => \{[\s\S]*?\n\t\}, \[content, disabled\]\)/);
	assert.ok(deltaEffect, "找不到 delta 入队 effect");
	const skipAt = deltaEffect[0].indexOf("if (streamDoneRef.current)");
	const classifyAt = deltaEffect[0].indexOf("classifySmoothStreamChange");
	assert.ok(skipAt >= 0, "delta effect 必须在流已结束时早退（跳过 classify 与入队）");
	assert.ok(classifyAt > skipAt, "早退必须发生在 classify 之前");
});

test("205KB 级 append 分类语义不因长度改变", () => {
	const prev = "preview-";
	const next = prev + "x".repeat(205 * 1024);
	const change = classifySmoothStreamChange(prev, prev, next);
	assert.equal(change.kind, "append");
	assert.equal(change.delta.length, 205 * 1024);
});
