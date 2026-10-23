import assert from "node:assert/strict";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();

function block(selector) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = css.match(new RegExp(`${escaped} \\{([^}]*)\\}`));
	assert.ok(match, `missing ${selector}`);
	return match[1];
}

test("light theme background tokens are neutral (no green tint)", () => {
	// 大面积背景为纯白基底（#113 中性化改版：灰只用于控件表面/hover/选中层级，均不得带色相）
	// ZCode 质感对齐（docs/zcode-design-analysis.md）：控件灰阶全部纯中性 R=G=B，
	// sidebar 刻意退一档 #f0f0f0（ZCode sidebar 同值）：主次分明——正文白卡浮在 chrome 上（见 tests/sidebarChromeHierarchy.test.mjs）
	assert.match(block(":root"), /--color-bg-app:\s*#ffffff;/i);
	assert.match(block(":root"), /--color-bg-sidebar:\s*#f0f0f0;/i);
	assert.match(block(":root"), /--color-bg-panel:\s*#ffffff;/i);
	assert.match(block(":root"), /--color-bg-muted:\s*#f4f4f4;/i);
	assert.match(block(":root"), /--color-bg-hover:\s*#e4e4e4;/i);
	assert.match(block(":root"), /--color-bg-active:\s*#dcdcdc;/i);
	// 文字墨水同样纯中性：去 slate/zinc 残留色相（secondary 旧 #4b5563 B−R=24 偏蓝）。
	// 浅色（过程层）同理——B>R 的冷调在灰阶里就是「发脏」的来源。
	assert.match(block(":root"), /--color-text-secondary:\s*#4a4a4a;/i);
	assert.match(block(":root"), /--color-text-tertiary:\s*#666666;/i);
	assert.match(block(":root"), /--color-text-faint:\s*#9a9a9a;/i);
	// 边框也墨水化（ZCode 同法）：旧 #e5e5e5/#dfdfdf/#d7d7d7 换 rgba(13,13,13,alpha)，
	// 叠在任何表面色相永远中性一致（见 docs/zcode-design-analysis.md）。
	assert.match(block(":root"), /--color-border-subtle:\s*rgba\(13, 13, 13, 0\.1\);/i);
	assert.match(block(":root"), /--color-border-default:\s*rgba\(13, 13, 13, 0\.13\);/i);
	assert.match(block(":root"), /--color-border-strong:\s*rgba\(13, 13, 13, 0\.17\);/i);
});
