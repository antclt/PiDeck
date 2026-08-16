import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadModule(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => require(specifier),
  }, { filename: filePath });
  return module.exports;
}

const notifications = loadModule("src/renderer/src/utils/runtimeNotification.ts");

test("runtime notifications dedupe the same request across component remounts", () => {
  const key = notifications.getRuntimeNotificationKey("session-a", 3, "notify-a");
  assert.equal(notifications.rememberRuntimeNotification(key), true);
  assert.equal(notifications.rememberRuntimeNotification(key), false);
});

test("background Ask stays deduped across focus changes until the request ends", () => {
  const key = "session-background:2:ask-a";
  assert.equal(notifications.rememberBackgroundAsk(key), true);
  assert.equal(notifications.rememberBackgroundAsk(key), false);
  assert.ok(notifications.getRememberedBackgroundAskKeys().includes(key));
  notifications.forgetBackgroundAsk(key);
  assert.equal(notifications.rememberBackgroundAsk(key), true);
});

test("runtime notification keys isolate sessions, generations, and request ids", () => {
  const a = notifications.getRuntimeNotificationKey("session-a", 4, "notify-b");
  const otherSession = notifications.getRuntimeNotificationKey("session-b", 4, "notify-b");
  const otherGeneration = notifications.getRuntimeNotificationKey("session-a", 5, "notify-b");
  const otherRequest = notifications.getRuntimeNotificationKey("session-a", 4, "notify-c");
  assert.notEqual(a, otherSession);
  assert.notEqual(a, otherGeneration);
  assert.notEqual(a, otherRequest);
});

test("describeBackgroundAsk splits session name from question, defaulting session name", () => {
  const withQuestion = notifications.describeBackgroundAsk({
    sessionName: "重构会话",
    requestTitle: "帮我重构 useQueuedPrompt",
    defaultSessionName: "默认会话",
  });
  assert.equal(withQuestion.sessionName, "重构会话");
  assert.equal(withQuestion.question, "帮我重构 useQueuedPrompt");

  const fallback = notifications.describeBackgroundAsk({
    sessionName: "   ",
    requestTitle: undefined,
    defaultSessionName: "默认会话",
  });
  assert.equal(fallback.sessionName, "默认会话");
  assert.equal(fallback.question, undefined);
});
