import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pure official：底栏改为 shadcn ghost icon Button，不再依赖 v3-braun 的
 * `.icon-button { border:0 }` CSS 契约。
 */

const sidebar = readFileSync(
  "src/renderer/src/components/sidebar/SidebarContent.tsx",
  "utf8",
);

test("v3 sidebar bottom buttons are shadcn ghost icons without CSS border rules", () => {
  assert.match(sidebar, /sidebar-bottom-actions/);
  assert.match(sidebar, /variant="ghost"/);
  assert.match(sidebar, /settings-icon/);
  assert.match(sidebar, /feedback-icon/);
  assert.match(sidebar, /homepage-icon/);
  // 底栏动作都走 size-8 icon button（size-8 后可能还有 hover/圆角等辅助类）；
  // 早期曾有 config-icon 第四个入口，已由设置面板收口，底栏固定三个
  assert.equal((sidebar.match(/className="icon-button [a-z-]+ size-8[^"]*"/g) || []).length, 3);
});
