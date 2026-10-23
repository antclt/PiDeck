import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 主次分明守卫（2026-10 对齐 ZCode 排版）：左右两侧 chrome 与正文面板必须有底色层次。
 *
 * - 经典浅色：sidebar 极浅灰退一档，正文面板保持纯白（白卡浮在 chrome 上）。
 * - 经典暗色：方向相反，sidebar 更暗、正文面板更亮。
 * - 右抽屉 .detail-drawer 必须与左侧栏共用 --color-bg-sidebar，两侧 chrome 对称。
 *
 * 皮肤（fresh-green 等）自带更深分层，不在本测试断言范围。
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const foundation = readFileSync(path.join(root, "src/renderer/src/styles/foundation.css"), "utf8");
const timeline = readFileSync(path.join(root, "src/renderer/src/styles/timeline.css"), "utf8");

function tokenFrom(block, name) {
	return block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
}

function rootBlock() {
	return foundation.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

function darkBlock() {
	return foundation.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
}

test("classic light keeps sidebar recessed below the pure-white content panel", () => {
	const block = rootBlock();
	const sidebar = tokenFrom(block, "color-bg-sidebar");
	const panel = tokenFrom(block, "color-bg-panel");
	assert.ok(sidebar, "浅色 --color-bg-sidebar 必须存在");
	assert.equal(panel, "#ffffff", "浅色正文面板必须保持纯白（内容浮在 chrome 之上）");
	assert.notEqual(sidebar, panel, "浅色侧栏必须与正文面板拉开底色层次");
});

test("classic dark keeps sidebar darker than the content panel", () => {
	const block = darkBlock();
	const sidebar = tokenFrom(block, "color-bg-sidebar");
	const panel = tokenFrom(block, "color-bg-panel");
	assert.ok(sidebar && panel, "暗色 sidebar/panel token 必须存在");
	assert.notEqual(sidebar, panel, "暗色侧栏必须与正文面板拉开底色层次");
});

test("right drawer shares the sidebar chrome tone", () => {
	const rule = timeline.match(/(?:^|\n)\.detail-drawer \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.match(rule, /background:\s*var\(--color-bg-sidebar\)/, ".detail-drawer 底色必须走 --color-bg-sidebar（与左栏同档 chrome）");
});
