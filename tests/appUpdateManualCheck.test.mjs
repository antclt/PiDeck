import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 更新检查策略（2026-12 兼容期调整）：启动后自动检查一次，有新版本直接弹窗；
// 用户打开禁用开关后不再自动检测（设置页手动按钮仍可用），且不存在周期定时器。
test("app update auto-checks once at startup and never runs periodically while disabled", () => {
  const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
  const devTabSource = readFileSync(
    "src/renderer/src/components/app/settings/DevTab.tsx",
    "utf8",
  );

  // 旧实现：启动 5s + 每 6h 自动检测；setTimeout 未存引用，切禁用时旧定时器照跑。
  // 2026-12 改为「启动单次检查 + 禁用开关门控」：弹窗依赖检查结果，但绝无周期定时器。
  assert.doesNotMatch(
    appSource,
    /1000 \* 60 \* 60 \* 6/,
    "periodic auto check timer must not exist",
  );
  // 启动单次自动检查必须存在（更新弹窗数据源），且受 disableUpdateCheck 门控。
  assert.match(
    appSource,
    /appUpdate\.check\("auto"\)/,
    "startup auto check must be scheduled once",
  );
  assert.match(
    appSource,
    /settings\.disableUpdateCheck/,
    "auto check must respect the disable update check setting",
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
