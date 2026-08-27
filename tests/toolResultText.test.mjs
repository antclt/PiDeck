import assert from "node:assert/strict";
import test from "node:test";
import { splitByPaths } from "../src/renderer/src/utils/toolResultPaths.ts";

/**
 * 工具结果（bash/find/grep 纯文本输出）的路径拆分：与 remarkLinkifyPaths 共用
 * matchPlainFilePaths，但只做文本级拆分（不跑 markdown），路径段由 ToolResultText
 * 渲染为可点击链接。死链（文件不存在）由 verdict 降级纯文本，这里只校验拆分边界。
 */

test("no paths: returns single text segment unchanged", () => {
	assert.deepEqual(splitByPaths("just some text\nno paths here"), [
		{ type: "text", value: "just some text\nno paths here" },
	]);
});

test("splits relative ./ and absolute paths from surrounding text", () => {
	const text = "found:\n./packages/a/src/x.ts\nand F:/PiDeck/src/main/index.ts done";
	const segs = splitByPaths(text);
	assert.deepEqual(
		segs.map((s) => (s.type === "text" ? "T" : s.path)),
		["T", "./packages/a/src/x.ts", "T", "F:/PiDeck/src/main/index.ts", "T"],
	);
	// 拼接回来与原文一致（没丢字符）
	assert.equal(
		segs.map((s) => (s.type === "text" ? s.value : s.path)).join(""),
		text,
	);
});

test("bare filename without separator is not linkified (avoid false positives)", () => {
	// app.ts 单独成词没有目录分隔符，不应被当路径（会误伤大量普通词）
	const segs = splitByPaths("see app.ts here");
	assert.deepEqual(segs, [{ type: "text", value: "see app.ts here" }]);
});

test("url tails are not matched as paths", () => {
	const segs = splitByPaths("doc at https://example.com/docs/readme.md end");
	assert.deepEqual(segs, [{ type: "text", value: "doc at https://example.com/docs/readme.md end" }]);
});

test("backslash windows paths in cmd output are split correctly", () => {
	const text = "F:\\PiDeck\\src\\main\\index.ts exists";
	const segs = splitByPaths(text);
	// 路径在开头：匹配前无文本段 → [path, " exists"] 两段
	assert.equal(segs.length, 2);
	assert.equal(segs[0].type, "path");
	assert.equal(segs[0].path, "F:\\PiDeck\\src\\main\\index.ts");
	assert.deepEqual(segs[1], { type: "text", value: " exists" });
});