import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * relativeTime 纯函数单测：transpile 后以 vm 加载，mock 掉 i18n 依赖，
 * 让 t(key, params) 按 "{count} 秒前" 这类占位符替换返回，直接断言边界分档。
 */

const I18N_TEMPLATES = {
  "session.relativeSeconds": "{count} 秒前",
  "session.relativeMinutes": "{count} 分钟前",
  "session.relativeHours": "{count} 小时前",
  "session.relativeDays": "{count} 天前",
  "session.relativeMonths": "{count} 个月前",
  "session.relativeYears": "{count} 年前",
};

function loadModule() {
  const output = ts.transpileModule(
    readFileSync("src/renderer/src/utils/relativeTime.ts", "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: "relativeTime.ts",
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    JSON,
    Object,
    Math,
    Date,
    require: (specifier) => {
      if (specifier === "../i18n") {
        return {
          t: (key, params) => {
            const template = I18N_TEMPLATES[key] ?? key;
            return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));
          },
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  }, { filename: "relativeTime.ts" });
  return module.exports;
}

/** 构造「now - elapsedMs」的时间戳，让用例不依赖真实时钟。 */
function tsAgo(elapsedMs) {
  return Date.now() - elapsedMs;
}

test("seconds bucket under 60s", () => {
  const { formatRelativeTime } = loadModule();
  assert.equal(formatRelativeTime(tsAgo(5000)), "5 秒前");
  assert.equal(formatRelativeTime(tsAgo(0)), "0 秒前");
});

test("minutes bucket from 60s to <1h", () => {
  const { formatRelativeTime } = loadModule();
  assert.equal(formatRelativeTime(tsAgo(60_000)), "1 分钟前");
  assert.equal(formatRelativeTime(tsAgo(59 * 60_000)), "59 分钟前");
});

test("hours bucket from 1h to <24h", () => {
  const { formatRelativeTime } = loadModule();
  assert.equal(formatRelativeTime(tsAgo(3_600_000)), "1 小时前");
  assert.equal(formatRelativeTime(tsAgo(23 * 3_600_000)), "23 小时前");
});

test("days bucket from 24h to <30d", () => {
  const { formatRelativeTime } = loadModule();
  assert.equal(formatRelativeTime(tsAgo(24 * 3_600_000)), "1 天前");
  assert.equal(formatRelativeTime(tsAgo(29 * 86_400_000)), "29 天前");
});

test("months bucket from 30d to <1y, then years", () => {
  const { formatRelativeTime } = loadModule();
  assert.equal(formatRelativeTime(tsAgo(30 * 86_400_000)), "1 个月前");
  assert.equal(formatRelativeTime(tsAgo(11 * 30 * 86_400_000)), "11 个月前");
  assert.equal(formatRelativeTime(tsAgo(365 * 86_400_000)), "1 年前");
});

test("future timestamps clamp to 0 seconds", () => {
  const { formatRelativeTime } = loadModule();
  assert.equal(formatRelativeTime(Date.now() + 10_000), "0 秒前");
});
