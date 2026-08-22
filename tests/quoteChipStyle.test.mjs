import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const mentionChip = readFileSync(
  "src/renderer/src/components/session/composer/tiptap/mentionChip.ts",
  "utf8",
);

/**
 * 引用 chip 的单行视觉契约（2026-09 划选引用）：
 * chip 是 #q<id> 快照指针，label 已在 quoteChip.truncateQuoteLabel 截断，
 * 但 CSS 必须强制单行省略——否则长划选把输入框撑成多行（用户实测回归）。
 */
test("quote chip enforces single-line ellipsis and quote-tone visuals", () => {
  // 双类名选择器：特异性必须压过同文件基类 .composer .input-chip 的
  // display:inline / word-break:break-all，靠顺序赢不住层内重排
  assert.match(
    timelineCss,
    /\.composer \.input-chip\.input-chip--quote[\s\S]*?\{[\s\S]*?white-space:\s*nowrap;/,
  );
  const quoteRule = timelineCss.match(
    /\.composer \.input-chip\.input-chip--quote[\s\S]*?\{([\s\S]*?)\}/,
  )?.[1] ?? "";
  for (const prop of [
    "display: inline-block",
    "max-width:",
    "overflow: hidden",
    "text-overflow: ellipsis",
    "background:",
    "border:",
  ]) {
    assert.ok(
      quoteRule.includes(prop),
      `quote chip rule must contain "${prop}", got: ${quoteRule}`,
    );
  }
  // 渲染端 class 拼接与样式选择器保持同名（input-chip--quote）
  assert.match(mentionChip, /input-chip--\$\{kind\}|input-chip--quote/);
});
