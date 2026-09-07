import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeModelDisplay, formatModelRef, resolveComposerLiveModel, resolveGuideDisplayModel } = loadTsCommonJs(
  "src/renderer/src/utils/modelPendingDisplay.ts",
);

function assertDisplay(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("computeModelDisplay: 无待生效时展示当前模型", () => {
  assertDisplay(
    computeModelDisplay({ provider: "openai", modelId: "gpt-5", modelName: "GPT-5" }, undefined),
    {
      from: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
      pending: false,
    },
  );
});

test("computeModelDisplay: 有待生效时展示 from→to", () => {
  assertDisplay(
    computeModelDisplay(
      { provider: "openai", modelId: "gpt-5" },
      {
        from: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
        to: { provider: "anthropic", modelId: "opus", modelName: "Opus" },
      },
    ),
    {
      from: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
      to: { provider: "anthropic", modelId: "opus", modelName: "Opus" },
      pending: true,
    },
  );
});

test("resolveComposerLiveModel: live 时优先 runtime state", () => {
  assertDisplay(
    resolveComposerLiveModel({
      state: { provider: "openai", modelId: "old-model", modelName: "Old" },
      record: { provider: "anthropic", modelId: "new-model" },
      fallback: { provider: "welcome", modelId: "welcome-model" },
      isLive: true,
    }),
    { provider: "openai", modelId: "old-model", modelName: "Old" },
  );
});

test("resolveComposerLiveModel: 非 live 时忽略残留 state，展示 catalog", () => {
  assertDisplay(
    resolveComposerLiveModel({
      state: { provider: "openai", modelId: "old-model", modelName: "Old" },
      record: { provider: "anthropic", modelId: "new-model" },
      fallback: { provider: "welcome", modelId: "welcome-model" },
      isLive: false,
    }),
    { provider: "anthropic", modelId: "new-model", modelName: "new-model" },
  );
});

test("resolveComposerLiveModel: 非 live 且无 record 时走 fallback", () => {
  assertDisplay(
    resolveComposerLiveModel({
      state: { provider: "openai", modelId: "old-model" },
      fallback: { provider: "welcome", modelId: "welcome-model", modelName: "Welcome" },
      isLive: false,
    }),
    { provider: "welcome", modelId: "welcome-model", modelName: "Welcome" },
  );
});

test("formatModelRef 带 provider", () => {
  assert.equal(
    formatModelRef({ provider: "grok.weishiair.de copy", modelId: "grok-4.6" }),
    "grok.weishiair.de copy/grok-4.6",
  );
});

test("契约: 运行中优先直接切换模型，后端 busy 时才排到下一轮", () => {
  const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
  const components = readFileSync(
    "src/renderer/src/components/session/ComposerComponents.tsx",
    "utf8",
  );
  const picker = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  const hook = readFileSync("src/renderer/src/hooks/usePendingModelApply.ts", "utf8");
  const ipc = readFileSync("src/shared/ipc.ts", "utf8");
  const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
  const preload = readFileSync("src/preload/index.ts", "utf8");

  assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
  assert.match(area, /modelPending=\{modelPendingMap\[props\.sessionId\]\}/);
  assert.match(area, /runtimeLive=\{isLiveRuntimeStatus\(composer\.runtime\?\.status\)\}/);
  assert.match(components, /disabled=\{props\.modelDisabled \?\? props\.disabled\}/);
  assert.match(components, /app\.modelPendingTitle/);
  assert.match(components, /resolveComposerLiveModel/);
  assert.match(picker, /resolveComposerLiveModel/);
  // 引导页展示决策必须走同一个纯函数：历史上 ComposerComponents 与 ComposerPickerHost
  // 各写了一份「defaultModelConfigured 闸门」，与主进程四级来源不同序，导致
  // 「配了默认模型就切不动」。这里锁住单一入口，防止再次分叉。
  assert.match(components, /resolveGuideDisplayModel/);
  assert.match(picker, /resolveGuideDisplayModel/);
  assert.doesNotMatch(components, /defaultModelConfigured/);
  assert.doesNotMatch(picker, /defaultModelConfigured/);
  assert.match(picker, /isLiveRuntimeStatus\(runtime\?\.status\)/);

  assert.match(picker, /setRuntimeModel/);
  assert.match(picker, /error\.code === "SESSION_RUNTIME_BUSY"/);
  assert.match(picker, /pickModelWhileBusy/);
  assert.match(picker, /listRuntimeModels\(handle\)/);
  assert.doesNotMatch(picker, /if \(handle && generationInFlight\)/);
  assert.match(picker, /usePendingModelApply/);
  assert.doesNotMatch(picker, /desktopApi\.sessions\.restartRuntime/);

  // 只有后端明确报告 busy 时才排队；不支持直接切换的新模型仍走重启确认。
  assert.match(
    picker,
    /if \(!snapshotHasModel\) \{\s*offerModelRestart\(handle, model\);\s*return;/,
  );

  // 后端拒绝即时切换后，才由 pending hook 在可用时重试。
  assert.match(hook, /setRuntimeModel/);
  assert.match(hook, /needsRestart/);

  assert.match(ipc, /sessionsRuntimeListModels: "sessions:runtime-list-models"/);
  assert.match(sessionIpc, /ipcChannels\.sessionsRuntimeListModels/);
  assert.match(sessionIpc, /listRuntimeModels\(target\)/);
  assert.match(preload, /listRuntimeModels: \(target: SessionRuntimeTarget\)/);
});

// ---- 引导页（无 record）展示决策：必须与主进程 resolveLaunchDefaultOptions 同序 ----

test("resolveGuideDisplayModel: 引导页点选优先于主进程预选默认", () => {
  // 旧规则下这里会返回预选默认（openai/gpt-5），即用户报告的「切不动」。
  assertDisplay(
    resolveGuideDisplayModel({
      isDsh: false,
      welcomeModel: { provider: "anthropic", modelId: "claude-opus-4-6" },
      defaultModel: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
    }),
    { provider: "anthropic", modelId: "claude-opus-4-6" },
  );
});

test("resolveGuideDisplayModel: 无点选时用预选默认（显式默认/切换列表/上次使用的折叠结果）", () => {
  assertDisplay(
    resolveGuideDisplayModel({
      isDsh: false,
      defaultModel: { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
    }),
    { provider: "openai", modelId: "gpt-5", modelName: "GPT-5" },
  );
});

test("resolveGuideDisplayModel: DSH 忽略 pi 点选偏好（模型路由归 host settings）", () => {
  assertDisplay(
    resolveGuideDisplayModel({
      isDsh: true,
      welcomeModel: { provider: "anthropic", modelId: "claude-opus-4-6" },
      defaultModel: { provider: "dsh-host", modelId: "agent-default" },
    }),
    { provider: "dsh-host", modelId: "agent-default" },
  );
});

test("resolveGuideDisplayModel: 点选与预选都为空时返回 undefined（底栏退回「模型: -」）", () => {
  assertDisplay(resolveGuideDisplayModel({ isDsh: false }), undefined);
});
