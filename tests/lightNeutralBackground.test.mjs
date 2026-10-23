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
	// sidebar 刻意退一档（#f7f7f7，完全中性无色相）：主次分明——正文白卡浮在 chrome 上（见 tests/sidebarChromeHierarchy.test.mjs）
	assert.match(block(":root"), /--color-bg-app:\s*#ffffff;/i);
	assert.match(block(":root"), /--color-bg-sidebar:\s*#f7f7f7;/i);
	assert.match(block(":root"), /--color-bg-panel:\s*#ffffff;/i);
	assert.match(block(":root"), /--color-bg-muted:\s*#f4f4f5;/i);
	assert.match(block(":root"), /--color-bg-hover:\s*#e5e7eb;/i);
	assert.match(block(":root"), /--color-bg-active:\s*#dfe3e8;/i);
	// 边框也中性化（修复前 #e5e5df 系带黄绿调）
	assert.match(block(":root"), /--color-border-subtle:\s*#e5e5e5;/i);
	assert.match(block(":root"), /--color-border-default:\s*#dfdfdf;/i);
	assert.match(block(":root"), /--color-border-strong:\s*#d7d7d7;/i);
});
