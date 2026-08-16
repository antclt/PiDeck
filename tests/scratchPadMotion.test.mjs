import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const styles = readRendererStyles();

function cssRule(selector) {
  return styles.match(new RegExp(`(?:^|\\n)${selector} \\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
}

test("scratch pad is a floating note: no full-screen backdrop, panel keeps entrance motion", () => {
  // 2026-12 兼容期：草稿本改为悬浮便签——overlay 不再画全屏遮罩（pointer-events:none
  // 不拦截点击、无背景色），不再有 backdrop 入场动画；面板保留自身入场动画。
  const overlayRule = cssRule("\\.scratch-pad-overlay");
  assert.ok(overlayRule, "scratch pad overlay styles must exist");
  assert.doesNotMatch(overlayRule, /background:/, "overlay must not paint a backdrop");
  assert.match(overlayRule, /pointer-events:\s*none;/);
  assert.match(cssRule("\\.scratch-pad-panel") ?? "", /pointer-events:\s*auto;/);
  assert.doesNotMatch(styles, /@keyframes scratch-pad-backdrop-enter/);
});

test("scratch pad releases the compositor layer after its entrance motion", () => {
  const overlay = cssRule("\\.scratch-pad-overlay");
  const panel = cssRule("\\.scratch-pad-panel");

  assert.ok(overlay, "scratch pad overlay styles must exist");
  assert.doesNotMatch(overlay, /backdrop-filter/);
  assert.ok(panel, "scratch pad panel styles must exist");
  assert.match(panel, /animation:\s*scratch-pad-enter 180ms/);
  assert.doesNotMatch(panel, /will-change:\s*opacity, transform;/);
  assert.match(styles, /@keyframes scratch-pad-enter \{[\s\S]*?transform:\s*none;/);
});
