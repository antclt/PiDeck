import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  loadProjectFileTree,
  shouldApplyFileTreeResult,
} = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

function file(name, path) {
  return { name, path, relativePath: name, type: "file" };
}

test("shouldApplyFileTreeResult rejects a stale project or generation", () => {
  assert.equal(shouldApplyFileTreeResult("a", "a", 2, 2), true);
  // 项目已切走：旧 listing 即使代次碰巧相同也不能写入。
  assert.equal(shouldApplyFileTreeResult("a", "b", 2, 2), false);
  // 同项目但已发起更新的请求：旧代次必须丢弃。
  assert.equal(shouldApplyFileTreeResult("a", "a", 1, 2), false);
});

test("loadProjectFileTree returns null when the request is superseded mid-flight", async () => {
  let current = "A";
  let resolveA;
  const pendingA = new Promise((resolve) => {
    resolveA = resolve;
  });

  const stale = loadProjectFileTree(
    async () => pendingA,
    [],
    () => current === "A",
  );

  // 模拟用户在 A 的 IPC 返回前切到 B。
  current = "B";
  resolveA([file("from-a.txt", "/a/from-a.txt")]);

  assert.equal(await stale, null);
});

test("project file tree refresh and expand drop stale listings", () => {
  const sync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");

  // #159：切项目后旧 files:list 仍可能很晚返回，必须按代次/当前项目丢弃。
  assert.match(sync, /loadProjectFileTree/);
  assert.match(sync, /fileTreeGenerationRef/);
  assert.match(sync, /beginFileTreeRequest/);
  assert.match(app, /setFiles\(\[\]\)/);
  assert.match(app, /beginFileTreeRequest\(\)/);
  assert.match(app, /isFileTreeRequestCurrent\(generation, projectId\)/);
});
