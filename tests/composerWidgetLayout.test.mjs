import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const layoutPath = "src/renderer/src/components/session/ComposerWidgetLayout.tsx";

function loadLayoutHelpers() {
  const source = readFileSync(layoutPath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: layoutPath,
  }).outputText;
  const context = { Provider: () => null };
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "react") {
        return {
          createContext: () => context,
          forwardRef: (render) => render,
          useCallback: (callback) => callback,
          useContext: () => null,
          useMemo: (factory) => factory(),
        };
      }
      if (specifier === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
      if (specifier === "@/lib/utils") return { cn: (...parts) => parts.filter(Boolean).join(" ") };
      return {};
    },
  }, { filename: layoutPath });
  return module.exports;
}

test("widget disclosure state is isolated by identity and preserves defaults", () => {
  const {
    resolveComposerWidgetCollapsed,
    toggleComposerWidgetCollapsed,
  } = loadLayoutHelpers();
  const initial = {};

  assert.equal(resolveComposerWidgetCollapsed(initial, "todo:session-a", true), true);
  const expanded = toggleComposerWidgetCollapsed(initial, "todo:session-a", true);
  assert.notEqual(expanded, initial, "state updates must remain immutable");
  assert.equal(resolveComposerWidgetCollapsed(expanded, "todo:session-a", true), false);
  assert.equal(resolveComposerWidgetCollapsed(expanded, "todo:session-b", true), true);

  const collapsedAgain = toggleComposerWidgetCollapsed(expanded, "todo:session-a", true);
  assert.equal(resolveComposerWidgetCollapsed(collapsedAgain, "todo:session-a", true), true);
  assert.equal(resolveComposerWidgetCollapsed(collapsedAgain, "goal:session-a", false), false);
});

test("a new modified-files run and each diff start from their own default disclosure state", () => {
  const {
    resolveComposerWidgetCollapsed,
    toggleComposerWidgetCollapsed,
  } = loadLayoutHelpers();
  const runOne = "modified-files:session-a:run-1";
  const firstDiff = "modified-file-diff:session-a:run-1:src/a.ts";
  const state = toggleComposerWidgetCollapsed(
    toggleComposerWidgetCollapsed({}, runOne, true),
    firstDiff,
    true,
  );

  assert.equal(resolveComposerWidgetCollapsed(state, runOne, true), false);
  assert.equal(resolveComposerWidgetCollapsed(state, firstDiff, true), false);
  assert.equal(
    resolveComposerWidgetCollapsed(state, "modified-files:session-a:run-2", true),
    true,
    "a completed run must not inherit the previous run's expansion",
  );
  assert.equal(
    resolveComposerWidgetCollapsed(state, "modified-file-diff:session-a:run-1:src/b.ts", true),
    true,
    "each diff disclosure remains independent",
  );
});

test("composer owns disclosure changes and gives the shared scrollport a trailing border guard", () => {
  const composer = readFileSync(
    "src/renderer/src/components/session/ComposerArea.tsx",
    "utf8",
  );
  const todo = readFileSync(
    "src/renderer/src/components/session/SessionTodoStrip.tsx",
    "utf8",
  );
  const goal = readFileSync(
    "src/renderer/src/components/session/SessionGoalStrip.tsx",
    "utf8",
  );
  const files = readFileSync(
    "src/renderer/src/components/session/SessionModifiedFilesStrip.tsx",
    "utf8",
  );
  const queue = readFileSync(
    "src/renderer/src/components/session/ComposerPanels.tsx",
    "utf8",
  );

  assert.match(composer, /const \[collapsedByWidgetKey, setCollapsedByWidgetKey\] = useState/);
  assert.match(composer, /useComposerWidgetLayoutValue\(/);
  assert.match(composer, /<ComposerWidgetLayoutProvider value=\{widgetLayoutValue\}>/);
  assert.match(
    composer,
    /overflow-y-auto overscroll-contain pb-px empty:hidden/,
    "the shared scrollport must reserve a physical row after its last card",
  );
  assert.match(composer, /Math\.max\(widgetsEl\.offsetHeight, widgetsEl\.scrollHeight\)/);

  for (const source of [todo, goal, files, queue]) {
    assert.match(source, /ComposerWidgetFrame/, "all composer cards must share the frame");
  }
  assert.match(todo, /useComposerWidgetCollapsed\([\s\S]*?`todo:\$\{props\.sessionId\}`/);
  assert.match(files, /useComposerWidgetCollapsed\([\s\S]*?modified-files:/);
  assert.match(files, /open=\{!collapsed\}/);
  assert.match(files, /onOpenChange=\{\(open\) => \{ setCollapsed\(!open\); \}\}/);
  assert.match(queue, /useComposerWidgetCollapsed\([\s\S]*?queue:/);
  assert.match(queue, /trackRef: RefObject<HTMLElement \| null>/);
});
