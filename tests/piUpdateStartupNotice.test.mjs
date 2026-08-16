import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("startup Pi update check is removed", () => {
  const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");

  // 回归：启动时不再自动检查 pi CLI 更新（曾在应用打开 1.2s 后弹
  // 「Pi 不是最新版本」toast 打扰启动流程）；版本检测只保留设置页手动入口。
  assert.doesNotMatch(app, /checkPiCliUpdateOnStartup/);
  assert.doesNotMatch(hook, /checkPiCliUpdateOnStartup|startupUpdateCheckDoneRef/);
});

test("opening dev settings does not auto-detect pi; cached result is shown directly", () => {
  const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
  const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
  const settings = readFileSync("src/shared/types/settings.ts", "utf8");

  // 回归：打开开发设置 tab 曾自动触发一次 pi 路径检测（spawn 探测），
  // 现在只有手动点「检测环境」才检测；已检测成功的结果从 settings 缓存直接恢复显示。
  assert.doesNotMatch(devTab, /activeTab === "dev" && props\.piStatus === null/);
  assert.match(devTab, /不自动检测 pi/);
  // settings 持久化字段 + 恢复逻辑（piStatus 为 null 时从缓存回填）
  assert.match(settings, /piInstall\?: \{ command: string; version: string \}/);
  assert.match(hook, /settings\.piInstall && piStatus === null/);
  assert.match(hook, /persistPiInstall/);
  // 未检测到时清除旧缓存，避免残留旧路径
  assert.match(hook, /清除旧缓存，避免残留/);
});
