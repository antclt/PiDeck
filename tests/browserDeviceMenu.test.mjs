import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Wave 5 浏览器域契约：设备菜单（自绘 absolute div）迁 Radix DropdownMenu。
 *
 * 背景（docs/ui-commercialization-plan.md Wave 5 施工 1）：
 * 浏览器 UA/设备切换菜单是手绘 absolute 定位 div + 手写 pointerdown 外点关闭，
 * 无 Esc、无焦点管理、无 menu 语义。迁共享 Radix 原语后由框架接管这批行为。
 *
 * 这里锁结构（同 browserPanelReadiness 的源码契约思路）：
 * 自绘版回归（重新出现 deviceMenuOpen state / 手写 pointerdown 关闭）即失败。
 */

const panel = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");

test("设备菜单用 Radix DropdownMenu 原语渲染", () => {
	assert.match(panel, /<DropdownMenu>/);
	assert.match(panel, /<DropdownMenuTrigger asChild>/);
	assert.match(panel, /<DropdownMenuContent align="end"/);
	// 选中项仍以 bg-bg-active 标记
	assert.match(panel, /preset\.id === device \? " bg-bg-active/);
});

test("自绘菜单的痕迹已清除：无 deviceMenuOpen state、无手写外点关闭", () => {
	assert.ok(!panel.includes("deviceMenuOpen"), "deviceMenuOpen 应由 Radix 自管");
	assert.ok(!panel.includes("deviceMenuRef"));
	assert.ok(!panel.includes('}, [deviceMenuOpen]);'), "手写 pointerdown 外点关闭 effect 应删除");
});

test("选中设备仍触发 selectDevice（UA 切换 + 视口 class）", () => {
	assert.match(panel, /onClick=\{\(\) => selectDevice\(preset\.id\)\}/);
	assert.match(panel, /moduleState\.device = nextDevice;/);
});
