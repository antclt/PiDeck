/**
 * 更新日志弹窗「默认只显示最新一个版本」的切分契约（2026-10-27 卡顿治理）。
 *
 * 事故：整本 CHANGELOG（400KB / 数十个版本）一次性交给 MarkdownStream，即便走
 * light 插件集，marked 解析 + sanitize + 一次 commit 出数万节点的成本仍随长度线性
 * 增长，打开弹窗明显卡顿。修复 = 默认只渲染首个 `## ` 版本段，展开才渲染全文。
 *
 * 这里守两件事：① 版本段边界只认 `## `（子标题不误切）；② 切分不丢/不改内容
 * —— sections 拼回去必须与原文「从首个版本标题起」的切片逐字节相同。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const MODULE = "src/renderer/src/components/app/settings/changelogSections.ts";
const { splitChangelogVersions } = loadTsCommonJs(MODULE);

const SAMPLE = ["# PiDeck", "", "导语一行。", "", "## v0.9.7 (2026-10-26)", "", "最新版本正文。", "", "### 🚀 New Features", "- 条目 A", "", "## v0.9.6 (2026-10-24)", "", "旧版本正文。", "", "## v0.7.8 - 2026-10-03", "", "更旧的正文。"].join("\n");

test("按 `## ` 切段：段数 = 版本数，首段是最新版本", () => {
	const { sections } = splitChangelogVersions(SAMPLE);
	assert.equal(sections.length, 3);
	assert.match(sections[0], /^## v0\.9\.7 \(2026-10-26\)/);
	assert.match(sections[2], /^## v0\.7\.8 - 2026-10-03/);
});

test("`### ` 子标题不切段（不是版本边界）", () => {
	const { sections } = splitChangelogVersions(SAMPLE);
	assert.equal(sections.length, 3, "🚀 New Features 是 ### 子标题，不能算一个版本");
	assert.match(sections[0], /### 🚀 New Features/);
});

test("切分不丢内容：sections 拼回 = 原文从首个版本标题起的切片（逐字节）", () => {
	const { sections } = splitChangelogVersions(SAMPLE);
	const firstHeading = SAMPLE.indexOf("## v0.9.7");
	assert.equal(sections.join("\n"), SAMPLE.slice(firstHeading));
});

test("导语是首个版本标题之前的行（trim 后的展示副本）", () => {
	const { intro } = splitChangelogVersions(SAMPLE);
	assert.equal(intro, "# PiDeck\n\n导语一行。");
});

test("没有导语时不产生多余 intro；单版本只有一段", () => {
	const single = "## v1.0.0 (2026-01-01)\n\n正文。";
	const { intro, sections } = splitChangelogVersions(single);
	assert.equal(intro, "");
	assert.equal(sections.length, 1);
	assert.equal(sections[0], single);
});

test("空输入与无版本标题的纯文本不抛错（降级为单段或空）", () => {
	assert.equal(splitChangelogVersions("").sections.length, 0);
	const plain = "只有一段没有版本标题的说明文字。";
	const result = splitChangelogVersions(plain);
	assert.equal(result.sections.length, 0);
	assert.equal(result.intro, plain);
});

test("ChangelogDialog 已接线：默认只渲染首段 + 展开按钮（防死代码回归）", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync("src/renderer/src/components/app/settings/ChangelogDialog.tsx", "utf8");
	assert.match(source, /splitChangelogVersions\(/, "必须使用版本切分");
	assert.match(source, /showAllVersions/, "必须存在展开态");
	assert.match(source, /split\.sections\[0\]/, "默认分支必须只渲染首个版本段");
	// 展开态在弹窗重新打开时复位，避免「上次展开了全文 → 这次打开又卡」。
	assert.match(source, /setShowAllVersions\(false\)/, "打开时必须复位展开态");
});
