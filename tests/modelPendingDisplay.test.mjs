import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeModelDisplay, formatModelRef, resolveComposerLiveModel } = loadTsCommonJs(
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
