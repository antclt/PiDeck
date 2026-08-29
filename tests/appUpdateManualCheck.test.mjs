import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 更新检查策略：只允许设置页「版本与更新」手动触发，应用启动/进入设置页均不得自动检查。
// 历史：f7a58852 曾改为纯手动，d348cc5a 又加回「启动自动检查一次」导致一进应用就检测、
// 且自动检查在途时手动按钮被 checking 门控吞掉（有更新也不弹）；此处回归断言纯手动策略。
test("app update check is manual-only and never runs automatically", () => {
  const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

  // 旧实现：启动 5s + 每 6h 自动检测；中间态：启动后单次自动检查。
  // 现策略：无任何自动检查入口（含 startup 单次），弹窗/提示只来自设置页手动按钮。
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
