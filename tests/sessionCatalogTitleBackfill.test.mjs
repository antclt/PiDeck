import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * SessionCatalog 占位标题回填测试（fetchTitle 注入链路）。
 *
 * 背景：侧栏轻量扫描（listPathSummary）不带 name，未打开过的 pi 会话标题落成
 * Untitled。mergeScanned 通过注入的 SessionTitleFetcher 对占位标题做有界读头部补名：
 * 只读「标题仍是占位符」的文件，已有真实标题的条目不触发读盘。
 */

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: filePath });
  return module.exports;
}

function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
  const identity = compileModule("src/shared/sessionIdentity.ts");
  const fsRetry = compileModule("src/main/utils/fsRetry.ts", {
    "node:fs/promises": fsPromises,
  });
  return compileModule("src/main/sessions/SessionCatalog.ts", {
    "../../shared/sessionIdentity": identity,
    "../utils/fsRetry": fsRetry,
    "../logging/sharedLogger": { getAppLogger: () => null },
    "node:fs/promises": fsPromises,
  });
}

/** 轻量扫描形态的 summary：name 缺失（listPathSummary 只 stat，不读正文）。 */
function lightSummary(overrides = {}) {
  return {
    id: "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl",
    filePath: "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl",
    name: undefined,
    preview: "",
    messageCount: 0,
    updatedAt: 1000,
    source: "pi",
    environment: "native",
    ...overrides,
  };
}

test("placeholder titles get backfilled from the injected fetcher on first scan", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-backfill-"));
  try {
    // 只对本测试的文件返回标题；其他文件返回 undefined 模拟「读不到正文」。
    const fetcher = async (filePath) =>
      filePath === "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl"
        ? "修复侧栏标题：未打开的会话显示首条消息"
        : undefined;
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();
    const [record] = await catalog.mergeScanned("project-1", [lightSummary()]);
    // 新条目不再落成 Untitled：头部补名提供真实标题。
    assert.equal(record.title, "修复侧栏标题：未打开的会话显示首条消息");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing Untitled entry is upgraded once the fetcher can infer a title", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-upgrade-"));
  try {
    // 第一次合并不注入 fetcher：条目创建成占位标题（旧行为）。
    const plain = new SessionCatalog(join(dir, "sessions.json"));
    await plain.load();
    const [first] = await plain.mergeScanned("project-1", [lightSummary()]);
    assert.equal(first.title, "Untitled");

    // 第二次合并注入 fetcher：占位标题应被升级为真实标题。
    const fetcher = async (filePath) =>
      filePath === "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl"
        ? "升级后的标题" : undefined;
    const upgraded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await upgraded.load();
    const [record] = await upgraded.mergeScanned("project-1", [lightSummary()]);
    assert.equal(record.title, "升级后的标题");
    // 升级结果应落盘：重启后仍是真实标题。
    const onDisk = JSON.parse(await nodeRequire("node:fs/promises").readFile(join(dir, "sessions.json"), "utf8"));
    assert.equal(onDisk.sessions[0].title, "升级后的标题");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("files with real titles never trigger the fetcher (no pointless reads)", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-no-call-"));
  try {
    let fetcherCalls = 0;
    const fetcher = async () => { fetcherCalls += 1; return "不该被调用"; };
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
    await catalog.load();
    // summary 自带真实名称（readSummary 全量路径的场景）：不触发补名。
    await catalog.mergeScanned("project-1", [lightSummary({ name: "已有真实标题" })]);
    assert.equal(fetcherCalls, 0);
    // 条目已有真实标题时，后续轻量扫描也不会触发补名。
    await catalog.mergeScanned("project-1", [lightSummary()]);
    assert.equal(fetcherCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without an injected fetcher the placeholder behavior stays intact", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-title-default-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const [record] = await catalog.mergeScanned("project-1", [lightSummary()]);
    // 未注入 fetcher（例如单元测试/无扫描器的安装点）：保持 Untitled 兜底，不回退。
    assert.equal(record.title, "Untitled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});