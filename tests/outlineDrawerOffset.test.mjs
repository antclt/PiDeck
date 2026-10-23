import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const styles = readRendererStyles();

test("right-side entries keep the same gap to the drawer splitter", () => {
	const outlineHover = styles.match(/\.outline-hover \{([\s\S]*?)\n\}/)?.[1];

	assert.ok(outlineHover, "right-side entry container styles must exist");
	assert.match(outlineHover, /right:\s*calc\(11px \+ var\(--drawer-splitter-w\) \+ max\(var\(--drawer-col-w\), min\(var\(--drawer-width\), 38vw\)\) \+ var\(--outline-content-w, 0px\)\);/);
});

/** 会话定位轴（刻度条）所在的容器规则块。 */
const paneBlock = styles.match(/\.outline-hover\.session-outline-pane \{([\s\S]*?)\n\}/)?.[1] ?? "";

test("会话定位轴贴消息区右缘，不得改到左缘", () => {
	assert.ok(paneBlock, "session outline pane styles must exist");
	// 右缘是设计基线（commit 3303200ae 曾把它挪到左缘，用户明确要求回右侧）
	assert.match(paneBlock, /right:\s*0;/);
	assert.doesNotMatch(paneBlock, /left:\s*0;/);
	assert.doesNotMatch(paneBlock, /align-items:\s*flex-start/);
});

test("定位轴静默态不可见，指针移入或键盘聚焦才浮现", () => {
	// 用户反馈「没放鼠标上去它就显示、占地方」：rest 必须 opacity: 0
	assert.match(styles, /\.outline-hover\.session-outline-pane\s*>\s*\*\s*\{[^}]*opacity:\s*0;/);
	assert.match(styles, /\.outline-hover\.session-outline-pane:hover\s*>\s*\*[^{]*\{[^}]*opacity:\s*1;/);
	// focus-within 兜住键盘用户：只用 :hover 会让键盘聚焦到不可见的刻度上
	assert.match(styles, /\.outline-hover\.session-outline-pane:focus-within\s*>\s*\*[^{]*\{[^}]*opacity:\s*1;/);
});
