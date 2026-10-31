import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const dropdownMenu = readFileSync("src/renderer/src/components/ui-shadcn/dropdown-menu.tsx", "utf8");
const contextMenu = readFileSync("src/renderer/src/components/ui-shadcn/context-menu.tsx", "utf8");
const titlebarInset = readFileSync("src/renderer/src/lib/titlebarInset.ts", "utf8");
const sonner = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

// 回归：侧栏会话/项目右键菜单弹出后，若被 flip+shift 顶到视口上沿，首项落在
// `.window-drag-layer`（--window-drag-height = 40px）的 drag 矩形里。Electron 的
// app-region 命中优先于 z-index，浮层画得上去却点不动（只有第一项中招，因为其余项在
// 热区下方）。两条防线必须都在：定位上让开热区 + 命中上兜底 no-drag。

test("radix portals outside .custom-titlebar-enabled still declare no-drag", () => {
	// 既有那批 no-drag 规则全部以 .custom-titlebar-enabled 开头，而 Radix 浮层 portal 到
	// body 不在该作用域内；app-region 不继承，必须对包裹层及其后代显式声明。
	assert.match(foundation, /\[data-radix-popper-content-wrapper\],\s*\n\[data-radix-popper-content-wrapper\] \* \{\s*\n\s*-webkit-app-region:\s*no-drag;/);
	// 同款兜底在 toast 上早已存在，别回退成只靠定位。
	assert.match(sonner, /\[data-sonner-toaster\],\s*\n\[data-sonner-toaster\] \* \{\s*\n\s*-webkit-app-region:\s*no-drag;/);
});

test("dropdown content reserves the titlebar drag height in collision detection", () => {
	// .window-drag-layer 是 fixed 透明热区，视口顶边 ≠ 可用顶边；Radix 默认碰撞边界是
	// 整个视口，必须显式留 padding，否则长菜单会被排进标题栏。
	assert.match(foundation, /--window-drag-height:\s*40px/);
	assert.match(titlebarInset, /getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--window-drag-height"\)/);
	// 原生标题栏 / 非浏览器环境下返回 undefined：行为与未接入时一致
	assert.match(titlebarInset, /if \(typeof window === "undefined"\) return undefined;/);
	assert.match(titlebarInset, /if \(!Number\.isFinite\(dragHeight\) \|\| dragHeight <= 0\) return undefined;/);
	// 正好一个热区高度：多加呼吸间距会把标题栏里按钮的下拉菜单推离触发器
	assert.match(titlebarInset, /return \{ top: dragHeight \};/);
	// 两个菜单原语都接上；调用方显式传入的 collisionPadding 优先，不被默认值覆盖。
	assert.match(dropdownMenu, /collisionPadding\s*\?\?\s*titlebarCollisionPadding\(\)/);
	assert.match(contextMenu, /collisionPadding\s*\?\?\s*titlebarCollisionPadding\(\)/);
	assert.match(dropdownMenu, /function DropdownMenuContent\(\{ className, sideOffset = 4, collisionPadding, \.\.\.props \}/);
	assert.match(contextMenu, /function ContextMenuContent\(\{ className, collisionPadding, \.\.\.props \}/);
});

test("titlebarCollisionPadding maps the drag height to top padding", () => {
	// 实际执行 helper：frameless 下取到 40px → top 40（= 热区高度，不额外加间距）；
	// 原生标题栏为 0px → undefined（行为不变）。
	const load = (dragHeightCssValue) =>
		loadTsCommonJs("src/renderer/src/lib/titlebarInset.ts", {
			globals: {
				window: {},
				document: { documentElement: {} },
				getComputedStyle: () => ({ getPropertyValue: (name) => (name === "--window-drag-height" ? dragHeightCssValue : "") }),
			},
		}).titlebarCollisionPadding;

	// 计算值带前导空格是常态（` 40px`），parseFloat 需能容忍
	assert.equal(load(" 40px")().top, 40);
	assert.equal(load("40px")().top, 40);
	assert.equal(load("0px")(), undefined);
	assert.equal(load("")(), undefined);
});

test("titlebarCollisionPadding is inert without a DOM", () => {
	// SSR / node 渲染（react-dom/server 快照测试）下不能抛错
	const { titlebarCollisionPadding } = loadTsCommonJs("src/renderer/src/lib/titlebarInset.ts");
	assert.equal(titlebarCollisionPadding(), undefined);
});
