import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const analyzer = loadTsCommonJs("src/main/cua/CuaWindowAnalyzer.ts", {
  stubs: {
    "./CuaWin32": {
      GetSystemMetrics: (nIndex) => (nIndex === 0 ? 2560 : 1440),
      enumerateWindows: () => [
        {
          hwnd: 1,
          title: "Foreground Window",
          pid: 100,
          rect: { x: 0, y: 0, width: 2560, height: 1440 },
          isVisible: true,
          isForeground: true,
          isTopmost: false,
          zIndex: 0,
        },
        {
          hwnd: 2,
          title: "Background Window",
          pid: 200,
          rect: { x: 100, y: 100, width: 800, height: 600 },
          isVisible: true,
          isForeground: false,
          isTopmost: false,
          zIndex: 1,
        },
      ],
    },
  },
});

test("analyzeWindows computes occlusion for foreground covering background", () => {
  const result = analyzer.analyzeWindows();
  assert.strictEqual(result.length, 2);

  const foreground = result.find((r) => r.window.hwnd === 1);
  const background = result.find((r) => r.window.hwnd === 2);

  assert.ok(foreground);
  assert.strictEqual(foreground.occludedArea, 0);
  assert.ok(foreground.titleBarPoint);

  assert.ok(background);
  // Background is fully covered by the fullscreen foreground window.
  assert.strictEqual(background.visibleRect.width, 0);
  assert.strictEqual(background.visibleRect.height, 0);
  assert.strictEqual(background.titleBarPoint, undefined);
});

test("findWindowByTitle returns matching window", () => {
  const found = analyzer.findWindowByTitle("Background");
  assert.ok(found);
  assert.strictEqual(found.window.hwnd, 2);
});

test("findWindowByTitle returns undefined for missing window", () => {
  const found = analyzer.findWindowByTitle("Missing");
  assert.strictEqual(found, undefined);
});
