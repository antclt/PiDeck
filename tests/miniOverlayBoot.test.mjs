import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync("src/renderer/index.html", "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

/** 在 React 下载前执行真实 HTML 内联脚本，检查首帧是否仍会出现开屏品牌动画。 */
function runBootstrap(search) {
	const classes = new Set();
	const overlays = [];
	const overlay = { remove: () => overlays.push("removed") };
	vm.runInNewContext(script, {
		URLSearchParams,
		location: { search },
		localStorage: { getItem: () => null },
		document: { documentElement: { classList: { add: (name) => classes.add(name) } }, getElementById: () => overlay },
	});
	return { classes, overlays };
}

test("悬浮小窗 HTML 首帧隐藏开屏动画，不等 React 或淡出定时器", () => {
	const { classes } = runBootstrap("?mini-overlay=1");
	assert.ok(classes.has("skip-boot-overlay"));
	assert.match(html, /html\.skip-boot-overlay\s+#boot-overlay\s*\{[^}]*display\s*:\s*none\s*;/);
});

test("正常工作台冷启动保留启动交接遮罩", () => {
	assert.equal(runBootstrap("").classes.has("skip-boot-overlay"), false);
});

test("启动内联脚本保持 CSP 内容哈希授权", () => {
	const hash = createHash("sha256").update(script).digest("base64");
	assert.ok(html.includes(`'sha256-${hash}'`));
});
