/**
 * 深层目录 watch 降级提示（W3）：用户必须能看到「哪些目录没有实时刷新」。
 *
 * 只验证用户可见行为：无降级不渲染任何东西；降级时给出覆盖/缺口计数；中英词典都有同一组占位符。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteDirWatchDegradedHint } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteDirWatchDegradedHint.tsx", { stubs: { react: React } });
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");

const DEGRADED = { degraded: true, reason: "watcher-capacity", desired: 40, covered: 32, dropped: 8 };

test("没有降级时不渲染提示（正常目录树不被打扰）", () => {
	assert.equal(renderToStaticMarkup(React.createElement(RemoteDirWatchDegradedHint, { dirWatch: null })), "");
});

test("降级时明示覆盖缺口：desired/covered/dropped 都在文案里", () => {
	const html = renderToStaticMarkup(React.createElement(RemoteDirWatchDegradedHint, { dirWatch: DEGRADED }));
	assert.match(html, /data-testid="remote-file-tree-watch-degraded"/);
	assert.match(html, /40/);
	assert.match(html, /32/);
	assert.match(html, /8/);
	assert.match(html, /手动刷新/);
});

test("中英词典都有降级文案与三个占位符", () => {
	for (const [dictionary, label] of [
		[zhCN, "zh-CN"],
		[enUS, "en-US"],
	]) {
		const copy = dictionary["project.remote.dirWatchDegraded"];
		assert.ok(copy, label + " 缺少 project.remote.dirWatchDegraded");
		for (const placeholder of ["{desired}", "{covered}", "{dropped}"]) assert.ok(copy.includes(placeholder), label + " 缺少占位符 " + placeholder);
	}
});
