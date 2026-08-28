import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 底栏 dock 主题按钮的循环规则（themeAppearance.nextThemeMode）：
 * 浅色 → 暗色 → 跟随系统 → 浅色；「跟随时间」(schedule) 不进循环，
 * 点击视为退出自动模式、手动落到浅色。
 */

const { nextThemeMode } = loadTsCommonJs("src/renderer/src/themeAppearance.ts");

test("theme button cycles light → dark → system → light", () => {
  assert.equal(nextThemeMode("light"), "dark");
  assert.equal(nextThemeMode("dark"), "system");
  assert.equal(nextThemeMode("system"), "light");
});

test("schedule mode is not part of the cycle; clicking exits to light", () => {
  assert.equal(nextThemeMode("schedule"), "light");
});
