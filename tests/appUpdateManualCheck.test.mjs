import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 更新检查调度已迁移到主进程 UpdateService（启动延迟 + 每 2h 后台自动检查，无配额方案）。
// 渲染层不得自建定时器或独立自动检查入口：自动弹窗/提示只由主进程 app:update-status-changed
// 快照推送触发（useBackgroundUpdateWatch）。历史：f7a58852 曾改为纯手动，d348cc5a 又加回
// 「启动自动检查一次」导致一进应用就检测、且自动检查在途时手动按钮被 checking 门控吞掉
//（有更新也不弹）；此处回归断言渲染层不再持有任何调度逻辑。
test("app update scheduling lives in main-process UpdateService; renderer must not self-schedule", () => {
  const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

  // 旧实现：启动 5s + 每 6h 自动检测；中间态：启动后单次自动检查。
  // 现策略：调度全部在主进程 UpdateService，渲染层只消费快照推送。
  assert.doesNotMatch(
    appSource,
    /1000 \* 60 \* 60 \* 6/,
    "periodic auto check timer must not exist",
  );
  assert.doesNotMatch(
    appSource,
    /appUpdate\.check\("auto"\)|check\("auto"\)/,
    "app update must never auto-check (startup or periodic)",
  );
  // 启动自动检查伴随的一次性 ref 也不得残留（否则说明自动路径仍可能被重新接上）
  assert.doesNotMatch(
    appSource,
    /autoCheckedUpdateRef/,
    "startup auto-check ref must not remain",
  );
});

test("dev settings update button stays manual and disabled while update check is disabled", () => {
  const devTabSource = readFileSync(
    "src/renderer/src/components/app/settings/DevTab.tsx",
    "utf8",
  );

  // 手动按钮：禁用时 onClick 为空且 loading 不显示（检查可能仍在途，但 UI 不得转圈）。
  // 按钮位于开发设置 tab（DevTab，自 SettingsModal 拆分）；disableUpdateCheck 为局部快捷变量
  assert.match(
    devTabSource,
    /onClick=\{disableUpdateCheck \? undefined : props\.onCheckUpdate\}/,
  );
  assert.match(
    devTabSource,
    /loading=\{props\.updateChecking && !disableUpdateCheck\}/,
  );
  assert.match(devTabSource, /disabled=\{disableUpdateCheck\}/);
});
