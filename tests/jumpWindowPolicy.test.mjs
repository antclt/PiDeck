import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

// jumpWindowPolicy 依赖 turnRenderWindow 的步长常量，require 需要能解析到同域模块
const turnRenderWindow = compile(
  "src/renderer/src/components/session/timeline/turnRenderWindow.ts",
);
const policy = compile(
  "src/renderer/src/components/session/timeline/jumpWindowPolicy.ts",
);
const sandboxRequire = (spec) =>
  spec.includes("turnRenderWindow") ? turnRenderWindow : {};

// 重新在带 require 解析的沙箱里执行 policy
{
  const output = ts.transpileModule(
    readFileSync("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: sandboxRequire });
  policy.resolveJumpPendingAction = module.exports.resolveJumpPendingAction;
  policy.JUMP_MAX_LOAD_ATTEMPTS = module.exports.JUMP_MAX_LOAD_ATTEMPTS;
}

const STEP = 3; // turnRenderWindow.TIMELINE_WINDOW_EXPAND_STEP

test("目标已加载未挂载：扩窗步长指数收敛并封顶（3→6→12→24）", () => {
  const turns = [0, 1, 2, 3, 4].map((attempts) =>
    policy.resolveJumpPendingAction({
      targetInLoadedData: true,
      hasMorePages: true,
      isLoadingPage: false,
      attempts,
    }),
  );
  assert.deepEqual(
    turns.map((action) => action.kind),
    ["expand", "expand", "expand", "expand", "expand"],
  );
  assert.deepEqual(
    turns.map((action) => action.turns),
    [STEP, STEP * 2, STEP * 4, STEP * 8, STEP * 8],
  );
});

test("目标已加载时无视补页状态，始终走扩窗", () => {
  const action = policy.resolveJumpPendingAction({
    targetInLoadedData: true,
    hasMorePages: true,
    isLoadingPage: true,
    attempts: 0,
  });
  assert.equal(action.kind, "expand");
});

test("目标未加载且无页可补：放弃跳转", () => {
  const action = policy.resolveJumpPendingAction({
    targetInLoadedData: false,
    hasMorePages: false,
    isLoadingPage: false,
    attempts: 0,
  });
  assert.equal(action.kind, "give-up");
});

test("目标未加载且补页在途：保持挂起等下一轮", () => {
  const action = policy.resolveJumpPendingAction({
    targetInLoadedData: false,
    hasMorePages: true,
    isLoadingPage: true,
    attempts: 0,
  });
  assert.equal(action.kind, "wait");
});

test("目标未加载且可补页：驱动补页；超过防呆上限后放弃", () => {
  const load = policy.resolveJumpPendingAction({
    targetInLoadedData: false,
    hasMorePages: true,
    isLoadingPage: false,
    attempts: policy.JUMP_MAX_LOAD_ATTEMPTS - 1,
  });
  assert.equal(load.kind, "load-page");

  const exhausted = policy.resolveJumpPendingAction({
    targetInLoadedData: false,
    hasMorePages: true,
    isLoadingPage: false,
    attempts: policy.JUMP_MAX_LOAD_ATTEMPTS,
  });
  assert.equal(exhausted.kind, "give-up");
});
