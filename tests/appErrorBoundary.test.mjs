import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("AppErrorBoundary renders a system-consistent error card", () => {
  const boundary = readFileSync("src/renderer/src/components/app/AppErrorBoundary.tsx", "utf8");
  const css = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

  // 组件结构：品牌 Logo + 状态胶囊 + 折叠堆栈 + 主次按钮
  assert.match(boundary, /LogoMark/);
  assert.match(boundary, /app-error-boundary-brand/);
  assert.match(boundary, /app-error-boundary-badge/);
  assert.match(boundary, /app-error-boundary-dot/);
  assert.match(boundary, /<StackTrace/);
  assert.match(boundary, /app-error-boundary-stack/);
  assert.match(boundary, /renderErrorStack/);
  assert.match(boundary, /handleReset/);
  assert.match(boundary, /handleReload/);
  // 全局边界会整页替换 AppHeader：卡片必须提供真正退出，且不要再叠一套 min/max/pin 挂件。
  // 不能走 closeWindow——closeToTray 会把关窗吞成隐藏，崩溃页再藏起来就退不掉。
  assert.match(boundary, /handleQuit/);
  assert.match(boundary, /app\.quit\(\)/);
  assert.match(boundary, /t\("app\.quit"\)/);
  assert.doesNotMatch(boundary, /app\.closeWindow\(/);
  assert.doesNotMatch(boundary, /handleClose/);
  assert.doesNotMatch(boundary, /t\("app\.windowClose"\)/);
  assert.doesNotMatch(boundary, /AppHeader/);
  assert.doesNotMatch(boundary, /ErrorBoundaryWindowChrome/);
  assert.doesNotMatch(boundary, /minimizeWindow/);
  assert.doesNotMatch(boundary, /toggleMaximizeWindow/);
  assert.doesNotMatch(css, /app-error-boundary-chrome/);
  assert.doesNotMatch(css, /\.app-error-boundary \.window-controls/);
  assert.match(css, /\.app-error-boundary-actions \{[\s\S]*?flex-wrap/);


  // 与系统一致的卡片语言：token 颜色 + shadcn 圆角/阴影；状态胶囊用 danger 语义色
  assert.match(css, /\.app-error-boundary-card \{/);
  assert.match(css, /background: var\(--color-bg-panel/);
  assert.match(css, /border: 1px solid var\(--color-border-default/);
  assert.match(css, /var\(--shadow-modal/);
  assert.match(css, /var\(--radius-lg/);
  assert.match(css, /\.app-error-boundary-badge \{/);
  assert.match(css, /var\(--color-danger-soft/);
  assert.match(css, /\.app-error-boundary-dot \{/);
  assert.match(css, /error-boundary-pulse/);

  // 去掉花哨元素：无 glitch/扫描线/大图标块；动效克制（入场 0.25s + 状态点呼吸）
  assert.doesNotMatch(css, /error-boundary-glitch/);
  assert.doesNotMatch(css, /error-boundary-scan/);
  assert.doesNotMatch(css, /app-error-boundary-icon/);
  assert.match(css, /error-boundary-rise 0\.25s ease-out both/);
  // 可访问性：reduced-motion 关闭动画
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
