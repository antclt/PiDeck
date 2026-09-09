import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("DropdownMenuItem and ContextMenuItem support descendant SVG coloring for destructive variant", () => {
  const dropdownMenuSrc = readFileSync(
    "src/renderer/src/components/ui-shadcn/dropdown-menu.tsx",
    "utf8"
  );
  const contextMenuSrc = readFileSync(
    "src/renderer/src/components/ui-shadcn/context-menu.tsx",
    "utf8"
  );

  // DropdownMenuItem 必须针对所有后代 svg 设置 !text-destructive，避免包裹在 span 内的图标被 muted-foreground 覆盖
  assert.match(
    dropdownMenuSrc,
    /data-\[variant=destructive\]:\[&_svg\]:!text-destructive/,
    "DropdownMenuItem should color all descendant SVGs as destructive"
  );

  // ContextMenuItem 也必须具有后代 svg 的 !text-destructive 样式
  assert.match(
    contextMenuSrc,
    /data-\[variant=destructive\]:\[&_svg\]:!text-destructive/,
    "ContextMenuItem should color all descendant SVGs as destructive"
  );
});

test("SessionTabsBar dangerous actions are configured with variant=destructive", () => {
  const tabsSrc = readFileSync(
    "src/renderer/src/components/session/SessionTabsBar.tsx",
    "utf8"
  );

  // 右侧更多菜单中的“停止 Agent”操作应标记为 destructive
  assert.match(
    tabsSrc,
    /<DropdownMenuItem[\s\S]*?variant="destructive"[\s\S]*?onSelect=\{props\.onStopCurrent\}/,
    "Stop Agent action in more dropdown menu should have variant='destructive'"
  );

  // Tab 右键 ContextMenu 中的“关闭其他标签页”和“关闭全部标签页”操作应标记为 destructive
  assert.match(
    tabsSrc,
    /<ContextMenuItem\s+variant="destructive"\s+onSelect=\{\(\)\s*=>\s*props\.onCloseOthers\(sessionId\)\}/,
    "Close others action in context menu should have variant='destructive'"
  );
  assert.match(
    tabsSrc,
    /<ContextMenuItem\s+variant="destructive"\s+onSelect=\{props\.onCloseAll\}/,
    "Close all action in context menu should have variant='destructive'"
  );
});
