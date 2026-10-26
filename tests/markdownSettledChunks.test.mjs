import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CHUNKER = "src/renderer/src/components/session/markdown/incrementalMarkdown.ts";
const POLICY = "src/renderer/src/components/session/markdownStreamPolicy.ts";
const STREAM = "src/renderer/src/components/session/MarkdownStream.tsx";
const { splitMarkdownChunks } = loadTsCommonJs(CHUNKER);
const { SETTLED_CHUNK_CHARS } = loadTsCommonJs(POLICY);

/**
 * 2026-10-27 事故回归（爆栈修复后的下半场）：点「展开全文」不再爆栈，但 205KB 全文
 * 走单次 <Streamdown mode="static"> 全量解析（数千块级元素一次 commit）是秒级冻结，
 * 「卡的不行，根本没法用」。修复 = settled 长文按顶层块切成 ≈32K 组渐进挂载。
 */

test("splitMarkdownChunks 拼接结果与原文逐字节相同（不丢字）", () => {
	const text = ["# 标题", "", "段落一。", "", "```js", "const a = 1;", "```", "", "- 列表项 1", "- 列表项 2", "", "> 引用行", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "结尾段落。"].join("\n");
	const chunks = splitMarkdownChunks(text, 64);
	assert.ok(chunks.length > 1, "小目标块长下必须切成多组");
	assert.equal(chunks.map((chunk) => chunk.text).join(""), text, "各块 span 必须依序吃满原文");
});

test("围栏/列表/表格块永不被切开", () => {
	const fence = "```python\nline1\nline2\nline3\n```\n";
	const list = "- a\n- b\n- c\n- d\n";
	const table = "| h |\n|---|\n| 1 |\n| 2 |\n";
	const text = `${fence}\n${list}\n${table}段落。\n`.repeat(6);
	const chunks = splitMarkdownChunks(text, 40);
	for (const chunk of chunks) {
		const fences = chunk.text.match(/```/g) ?? [];
		assert.equal(fences.length % 2, 0, "围栏标记必须成对出现在同一块内");
	}
	assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
});

test("单个巨型块独立成组，不再细分", () => {
	const giantFence = "```\n" + "x".repeat(5_000) + "\n```\n";
	const text = `${giantFence}${giantFence}`;
	const chunks = splitMarkdownChunks(text, 1_000);
	assert.equal(chunks.length, 2, "每个围栏是单个不可分块，独立成组");
	assert.equal(chunks[0].text, giantFence);
	assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
});

test("空文本返回空数组；小文本单块", () => {
	// vm 沙箱 realm 的 Array 原型与宿主不同，不能 deepEqual([])，按结构断言。
	assert.equal(splitMarkdownChunks("", 1_000).length, 0);
	const small = "只有一段。";
	const chunks = splitMarkdownChunks(small, 1_000);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].text, small);
});

test("MarkdownStream 已接线渐进分块（防死代码回归）", () => {
	const source = readFileSync(STREAM, "utf8");
	assert.match(source, /splitMarkdownChunks\(displayText, SETTLED_CHUNK_CHARS\)/, "settled 长文必须走分块");
	assert.match(source, /mountedChunkCount/, "必须存在渐进挂载计数");
	// 分块只应作用于 settled（非流式）路径：流式仍走冻结前缀 + 尾块。
	const settledCall = source.match(/settledChunks = useMemo\(\(\) => \{[\s\S]*?\}, \[/);
	assert.ok(settledCall, "找不到 settledChunks useMemo");
	assert.match(settledCall[0], /isStreamingNow/, "分块判定必须排除流式态");
});

test("分块阈值沿用既有档位（32K，与 30K≈2.3ms 实测同源）", () => {
	assert.equal(SETTLED_CHUNK_CHARS, 32_000);
});
