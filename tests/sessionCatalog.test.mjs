import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rename as renameFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

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
    // vm 默认不提供 timer 全局；SessionCatalog 的 rename 重试退避依赖 setTimeout
    setTimeout,
    clearTimeout,
  }, { filename: filePath });
  return module.exports;
}

function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
  const identity = compileModule("src/shared/sessionIdentity.ts");
  // fsRetry 是 SessionCatalog 的重试依赖；同样注入 mock fs，测试才能拦截 rename
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

function summary(overrides = {}) {
  return {
    id: "C:/sessions/example.jsonl",
    filePath: "C:/sessions/example.jsonl",
    name: "Example",
    preview: "hello",
    updatedAt: 100,
    messageCount: 1,
    source: "pi",
    ...overrides,
  };
}

test("does not restore an unsubmitted draft after the catalog is reloaded", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-draft-cleanup-"));
  const filePath = join(dir, "sessions.json");
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    await catalog.createDraft({
      projectId: "project-1",
      title: "Never submitted",
      environment: "native",
    });

    const reloaded = new SessionCatalog(filePath);
    await reloaded.load();
    assert.equal(reloaded.listEntries().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 回归：DSH 草稿必须跨重启保留（host 会话由 $DSH_HOME 持久化，catalog 只是映射）。
// 仅清除 pi 后端（backend !== "dsh"）的草稿；dsh draft（含带 dshSessionId 的异常
// 中间态）与 active 条目都应原样保留。
test("keeps dsh drafts across reload while clearing pi drafts", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-dsh-draft-"));
  const filePath = join(dir, "sessions.json");
  const now = Date.now();
  const entry = (overrides) => ({
    projectId: "project-1",
    title: "Entry",
    source: "pi",
    environment: "native",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const catalogFile = {
    version: 1,
    sessions: [
      entry({ id: "dsh-draft", title: "DSH draft", backend: "dsh", status: "draft" }),
      entry({
        id: "dsh-draft-with-session",
        title: "DSH draft (mid-activation)",
        backend: "dsh",
        status: "draft",
        dshSessionId: "session-host-orphan",
      }),
      entry({ id: "pi-draft", title: "Pi draft", status: "draft" }),
      entry({ id: "active", title: "Active", status: "active" }),
    ],
  };
  try {
    await writeFile(filePath, JSON.stringify(catalogFile), "utf8");
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    const ids = new Map(
      catalog.listEntries().map((item) => [item.id, item]),
    );
    assert.equal(ids.size, 3, "pi draft should be cleared on load");
    assert.equal(ids.get("dsh-draft")?.status, "draft", "dsh draft without dshSessionId must survive");
    assert.equal(
      ids.get("dsh-draft-with-session")?.status === "draft" && ids.get("dsh-draft-with-session")?.dshSessionId === "session-host-orphan",
      true,
      "dsh draft with dshSessionId (abnormal mid-state) must survive",
    );
    assert.equal(ids.get("active")?.status, "active", "active entry preserved");
    assert.equal(ids.get("pi-draft"), undefined, "pi draft removed from memory");
    // 清理结果应落盘：磁盘上也不再有 pi draft
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    const persistedIds = persisted.sessions.map((item) => item.id);
    assert.ok(persistedIds.includes("dsh-draft"), "dsh draft persisted after cleanup");
    assert.ok(persistedIds.includes("dsh-draft-with-session"), "dsh mid-state draft persisted after cleanup");
    assert.ok(!persistedIds.includes("pi-draft"), "pi draft not persisted after cleanup");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists an active session backend switch from pi to dsh", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-backend-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    // 未发送的 draft 会在重启时被清理（load 清理逻辑），要验证持久化必须让会话 active。
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "New session",
      environment: "native",
    });
    await catalog.attachRuntime({
      sessionId: draft.id,
      filePath: "C:\\Sessions\\Example.jsonl",
    });
    const updated = await catalog.update(draft.id, { backend: "dsh" });
    assert.equal(updated.backend, "dsh");
    const reloaded = new SessionCatalog(join(dir, "sessions.json"));
    await reloaded.load();
    assert.equal(reloaded.getRecord(draft.id)?.backend, "dsh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists DSH session id so a restarted app can attach the same host session", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-dsh-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "DSH session",
      environment: "native",
      backend: "dsh",
    });
    // DSH 会话没有 pi 会话文件：attachRuntime 只带 dshSessionId（backend=dsh 的 Coordinator 路径）。
    await catalog.attachRuntime({
      sessionId: draft.id,
      dshSessionId: "session-host-abc123",
    });
    const record = catalog.getRecord(draft.id);
    assert.equal(record?.dshSessionId, "session-host-abc123");
    assert.equal(record?.filePath, undefined, "DSH 会话不落 pi 会话文件");
    // 重启后 catalog 重载：dshSessionId 存活，Coordinator 可据此 attach 旧会话。
    const reloaded = new SessionCatalog(join(dir, "sessions.json"));
    await reloaded.load();
    const restored = reloaded.getRecord(draft.id);
    assert.equal(restored?.backend, "dsh");
    assert.equal(restored?.dshSessionId, "session-host-abc123");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("imports a foreign DSH session as active (survives restart cleanup, attachable)", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-foreign-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    // 外部（dsh-web 等）会话导入：createDraft 带 dshSessionId 直接置 active，
    // 不经过「创建→发送→attach」的激活链路。
    const imported = await catalog.createDraft({
      projectId: "project-1",
      title: "dsh-web session",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-foreign-xyz789",
    });
    assert.equal(imported.status, "active", "imported session must be active, not draft");
    assert.equal(imported.dshSessionId, "session-foreign-xyz789");
    // 重启清理只删 pi draft：active 的导入会话必须保留并可 attach。
    const reloaded = new SessionCatalog(join(dir, "sessions.json"));
    await reloaded.load();
    const restored = reloaded.getRecord(imported.id);
    assert.equal(restored?.status, "active");
    assert.equal(restored?.dshSessionId, "session-foreign-xyz789");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 回归：外部会话重复导入（自动同步与手动导入并发、配置页重复点击、host-ready 重放）
// 必须幂等吸收——同一 dshSessionId 只保留一条记录，后续导入只更新标题/项目归属，
// 否则侧栏出现两条同 host 会话记录（「重复导入」用户问题）。
test("createDraft with the same dshSessionId is idempotent (updates in place, no duplicate)", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-foreign-dedup-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const first = await catalog.createDraft({
      projectId: "project-1",
      title: "Old title",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-foreign-dedup-1",
    });
    const second = await catalog.createDraft({
      projectId: "project-2",
      title: "New title",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-foreign-dedup-1",
    });
    assert.equal(second.id, first.id, "same host session must resolve to the same catalog record");
    assert.equal(catalog.listEntries().length, 1);
    assert.equal(second.title, "New title");
    assert.equal(second.projectId, "project-2");
    assert.equal(second.status, "active");
    // 持久化同样只有一条：重启重载后不出现重复。
    const reloaded = new SessionCatalog(join(dir, "sessions.json"));
    await reloaded.load();
    assert.equal(reloaded.listEntries().length, 1);
    assert.equal(reloaded.getRecord(first.id)?.title, "New title");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createDraft keepExistingTitle preserves title while moving project", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-keep-title-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    await catalog.createDraft({
      projectId: "builtin-external",
      title: "Host 回写标题",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-keep-title",
    });
    const moved = await catalog.createDraft({
      projectId: "project-elsewhere",
      title: "elsewhere",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-keep-title",
      keepExistingTitle: true,
    });
    assert.equal(moved.title, "Host 回写标题");
    assert.equal(moved.projectId, "project-elsewhere");
    assert.equal(catalog.listEntries().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps a draft desktop session ID after Pi assigns a file path", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "New session",
      environment: "native",
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    });
    await catalog.attachRuntime({
      sessionId: draft.id,
      filePath: "C:\\Sessions\\Example.jsonl",
      piSessionId: "pi-123",
    });
    const records = await catalog.mergeScanned("project-1", [summary({
      filePath: "c:/sessions/example.jsonl",
      id: "c:/sessions/example.jsonl",
    })]);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, draft.id);
    assert.equal(records[0].status, "active");
    assert.equal(records[0].model?.provider, "openai");
    assert.equal(records[0].model?.modelId, "gpt-test");
    assert.equal(records[0].thinkingLevel, "high");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses the configured WSL identity when a draft becomes active", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"), {
      wslDistro: "Ubuntu",
      wslUser: "dev",
    });
    await catalog.load();
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "WSL draft",
      environment: "wsl",
    });
    await catalog.attachRuntime({
      sessionId: draft.id,
      filePath: "/home/dev/.pi/agent/sessions/example.jsonl",
    });
    const records = await catalog.mergeScanned("project-1", [summary({
      filePath: "/home/dev/.pi/agent/sessions/example.jsonl",
      id: "/home/dev/.pi/agent/sessions/example.jsonl",
      wsl: true,
    })], { wslDistro: "Ubuntu", wslUser: "dev" });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, draft.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps imported identity after activation and rescan", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  try {
    const imported = summary({
      source: "codex",
      codexSessionId: "codex-thread-42",
      filePath: "C:/sessions/codex.jsonl",
      id: "C:/sessions/codex.jsonl",
    });
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    const [first] = await catalog.mergeScanned("project-1", [imported]);
    await catalog.attachRuntime({
      sessionId: first.id,
      filePath: imported.filePath,
      piSessionId: "pi-imported",
    });

    const reloaded = new SessionCatalog(filePath);
    await reloaded.load();
    const rescanned = await reloaded.mergeScanned("project-1", [imported]);
    assert.equal(rescanned.length, 1);
    assert.equal(rescanned[0].id, first.id);
    assert.equal(rescanned[0].importedSourceId, "codex-thread-42");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("folds a scanner-created duplicate into the original draft ID", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "New session",
      environment: "native",
    });
    const scanned = summary({
      filePath: "C:/sessions/raced.jsonl",
      id: "C:/sessions/raced.jsonl",
    });
    const duringRace = await catalog.mergeScanned("project-1", [scanned]);
    assert.equal(duringRace.length, 2);

    await catalog.attachRuntime({
      sessionId: draft.id,
      filePath: "C:/sessions/raced.jsonl",
      piSessionId: "pi-raced",
    });
    const afterAttach = await catalog.mergeScanned("project-1", [scanned]);
    assert.equal(afterAttach.length, 1);
    assert.equal(afterAttach[0].id, draft.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovers a damaged primary catalog from its atomic backup", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    const first = await catalog.createDraft({
      projectId: "project-1",
      title: "First",
      environment: "native",
    });
    await catalog.attachRuntime({
      sessionId: first.id,
      filePath: "C:/sessions/first.jsonl",
      piSessionId: "pi-first",
    });
    const second = await catalog.createDraft({
      projectId: "project-1",
      title: "Second",
      environment: "native",
    });
    await catalog.attachRuntime({
      sessionId: second.id,
      filePath: "C:/sessions/second.jsonl",
      piSessionId: "pi-second",
    });
    await writeFile(filePath, "{truncated", "utf8");

    const recovered = new SessionCatalog(filePath);
    await recovered.load();
    assert.equal(recovered.listEntries().length, 1);
    assert.equal(recovered.listEntries()[0].id, first.id);
    const repaired = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(repaired.sessions[0].id, first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed atomic write does not poison later mutations or memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  let failPrimaryRename = true;
  const realFs = nodeRequire("node:fs/promises");
  const fsWithOneFailure = {
    ...realFs,
    rename: async (source, target) => {
      if (target === filePath && failPrimaryRename) {
        failPrimaryRename = false;
        const error = new Error("simulated rename failure");
        error.code = "EIO";
        throw error;
      }
      return renameFile(source, target);
    },
  };
  const { SessionCatalog } = loadCatalog(fsWithOneFailure);
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    await assert.rejects(
      catalog.createDraft({
        projectId: "project-1",
        title: "Failed",
        environment: "native",
      }),
      /simulated rename failure/,
    );
    assert.equal(catalog.listEntries().length, 0);

    const saved = await catalog.createDraft({
      projectId: "project-1",
      title: "Saved",
      environment: "native",
    });
    assert.equal(catalog.listEntries().length, 1);
    assert.equal(catalog.listEntries()[0].id, saved.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup rename EPERM after retries does not fail the catalog write (issue: create-draft blocked)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  const realFs = nodeRequire("node:fs/promises");
  // 备份轮换（.bak 目标）持续 EPERM：模拟杀软/其他进程长期锁住 .bak
  const fsWithLockedBackup = {
    ...realFs,
    rename: async (source, target) => {
      if (target.endsWith(".bak")) {
        const error = new Error("simulated locked backup rename");
        error.code = "EPERM";
        throw error;
      }
      return renameFile(source, target);
    },
  };
  const { SessionCatalog } = loadCatalog(fsWithLockedBackup);
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    // 备份轮换失败不应阻断主文件原子写入：新建会话必须仍然成功
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "Saved despite locked backup",
      environment: "native",
    });
    assert.equal(catalog.listEntries().length, 1);
    assert.equal(catalog.listEntries()[0].id, draft.id);
    const snapshot = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(snapshot.sessions[0].id, draft.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup rename transient EPERM recovers via retry and still rotates the backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  const realFs = nodeRequire("node:fs/promises");
  let backupRenameAttempts = 0;
  const fsWithFlakyBackup = {
    ...realFs,
    rename: async (source, target) => {
      if (target.endsWith(".bak")) {
        backupRenameAttempts += 1;
        // 前两次失败（模拟杀软瞬时扫描锁），第三次开始成功
        if (backupRenameAttempts <= 2) {
          const error = new Error("simulated transient backup lock");
          error.code = "EPERM";
          throw error;
        }
      }
      return renameFile(source, target);
    },
  };
  const { SessionCatalog } = loadCatalog(fsWithFlakyBackup);
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    // 首次写入没有可备份的主文件；第二次写入才触发备份轮换
    await catalog.createDraft({
      projectId: "project-1",
      title: "First",
      environment: "native",
    });
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "Recovered backup",
      environment: "native",
    });
    assert.ok(catalog.listEntries().some((entry) => entry.id === draft.id));
    // 重试成功后 .bak 应已轮换：内容是本次写入前的旧快照（滞后一版）
    const snapshot = JSON.parse(await readFile(filePath, "utf8"));
    const backup = JSON.parse(await readFile(`${filePath}.bak`, "utf8"));
    assert.equal(snapshot.sessions.length, 2);
    assert.equal(backup.sessions.length, 1);
    assert.equal(backup.sessions[0].title, "First");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps scanned child parent paths to desktop session IDs and survives reload", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    const first = await catalog.mergeScanned("project-1", [
      summary({ filePath: "C:/sessions/parent.jsonl", id: "C:/sessions/parent.jsonl", name: "Parent" }),
      summary({
        filePath: "C:/sessions/parent/child.jsonl",
        id: "C:/sessions/parent/child.jsonl",
        name: "Child",
        parentSessionPath: "c:/sessions/parent.jsonl",
      }),
    ]);
    const parent = first.find((record) => record.title === "Parent");
    const child = first.find((record) => record.title === "Child");
    assert.ok(parent);
    assert.equal(child?.parentSessionId, parent?.id);

    const reloaded = new SessionCatalog(filePath);
    await reloaded.load();
    const second = await reloaded.mergeScanned("project-1", [
      summary({ filePath: "c:/sessions/parent.jsonl", id: "c:/sessions/parent.jsonl", name: "Parent" }),
      summary({
        filePath: "c:/sessions/parent/child.jsonl",
        id: "c:/sessions/parent/child.jsonl",
        name: "Child",
        parentSessionPath: "C:/sessions/parent.jsonl",
      }),
    ]);
    assert.equal(second.find((record) => record.title === "Parent")?.id, parent?.id);
    assert.equal(second.find((record) => record.title === "Child")?.parentSessionId, parent?.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime event attachment rejects active origin changes but accepts metadata drafts", () => {
  const { canAttachRuntimeMetadata } = loadCatalog();
  const active = {
    id: "old",
    projectId: "project-1",
    title: "Old",
    source: "pi",
    environment: "native",
    filePath: "C:/sessions/old.jsonl",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(canAttachRuntimeMetadata(active, {
    sessionPath: "C:/sessions/new.jsonl",
    sessionSource: "pi",
    sessionEnvironment: "native",
  }), false);
  assert.equal(canAttachRuntimeMetadata({ ...active, filePath: undefined, status: "draft" }, {
    sessionPath: "C:/sessions/new.jsonl",
    sessionSource: "pi",
    sessionEnvironment: "native",
  }), true);
});

test("removes an unstarted draft from the durable catalog", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "Accidental agent",
      environment: "native",
    });
    assert.equal(catalog.get(draft.id)?.status, "draft");
    assert.equal(catalog.get(draft.id)?.filePath, undefined);

    assert.equal(await catalog.remove(draft.id), true);
    assert.equal(catalog.get(draft.id), undefined);
    const snapshot = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(snapshot.sessions.some((entry) => entry.id === draft.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps anonymous records in memory and excludes them from the durable catalog", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    const anonymous = catalog.createAnonymous({
      projectId: "project-1",
      title: "Anonymous Chat",
      environment: "native",
    });
    assert.equal(anonymous.noSession, true);
    assert.equal((await catalog.mergeScanned("project-1", [])).map((record) => record.id).includes(anonymous.id), true);
    await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);

    await catalog.createDraft({
      projectId: "project-1",
      title: "Saved draft",
      environment: "native",
    });
    const snapshot = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(snapshot.sessions.some((entry) => entry.id === anonymous.id), false);

    const reloaded = new SessionCatalog(filePath);
    await reloaded.load();
    assert.equal(reloaded.get(anonymous.id), undefined);
    assert.equal(catalog.removeTransient(anonymous.id), true);
    assert.equal(catalog.get(anonymous.id), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime replacement resolves a full-origin target without mutating the origin record", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const [origin] = await catalog.mergeScanned("project-1", [summary({
      source: "codex",
      codexSessionId: "import-origin",
      filePath: "/home/dev/origin.jsonl",
      id: "/home/dev/origin.jsonl",
      wsl: true,
    })], { wslDistro: "Ubuntu", wslUser: "dev" });
    const before = catalog.get(origin.id);

    const target = await catalog.ensureRuntimeTarget({
      projectId: "project-1",
      title: "Replacement",
      source: "codex",
      environment: "wsl",
      filePath: "/home/dev/replacement.jsonl",
      wslDistro: "Ubuntu",
      wslUser: "dev",
      importedSourceId: "import-target",
      piSessionId: "pi-target",
    });
    const repeated = await catalog.ensureRuntimeTarget({
      projectId: "project-1",
      title: "Replacement",
      source: "codex",
      environment: "wsl",
      filePath: "/home/dev/replacement.jsonl",
      wslDistro: "Ubuntu",
      wslUser: "dev",
      importedSourceId: "import-target",
      piSessionId: "pi-target",
    });

    assert.notEqual(target.id, origin.id);
    assert.equal(repeated.id, target.id);
    assert.equal(catalog.listEntries().filter((entry) => entry.id === target.id).length, 1);
    assert.deepEqual({ ...catalog.get(origin.id) }, { ...before });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


// ── 相对 sessionFile 归一化（2026-08 侧栏重复会话回归）─────────────
// 背景：pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，get_state 返回的
// sessionFile 是相对 cwd 的；原样写入 catalog 会与扫描器绝对路径 originKey 不同，
// 同一会话在侧栏出现两条记录（一条输入推断名 + 一条默认 "{项目名} agent"）。

function absolutePathResolver(projectRoot) {
  return (projectId, filePath, environment) => {
    assert.equal(projectId, "project-1");
    return filePath.startsWith(".")
      ? `${projectRoot}\\${filePath.replace(/^[\\/]+/, "")}`
      : filePath;
  };
}

test("load repairs legacy relative filePaths via the injected resolver", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  const filePath = join(dir, "sessions.json");
  try {
    // 模拟旧版本写入的相对路径条目（含按相对路径计算的旧 originKey）
    const legacy = {
      id: "rel-entry",
      projectId: "project-1",
      originKey: "pi:native:.pi/sessions/2026-08-08t10-47-19-239z_abc.jsonl",
      title: "PiDeck agent",
      source: "pi",
      environment: "native",
      filePath: ".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
      status: "active",
      createdAt: 1000,
      updatedAt: 1000,
    };
    await writeFile(filePath, JSON.stringify({ version: 1, sessions: [legacy] }), "utf8");

    const catalog = new SessionCatalog(
      filePath,
      {},
      absolutePathResolver("D:\\Project\\PiDeck"),
    );
    await catalog.load();

    const [entry] = catalog.listEntries();
    assert.equal(
      entry.filePath,
      "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
    );
    // originKey 必须随路径重算，否则后续 mergeScanned 仍按旧 key 去重
    assert.match(entry.originKey, /d:\/project\/pideck\/\.pi\/sessions/);

    // 修复结果应落盘，重启后不需要再修
    const onDisk = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(onDisk.sessions[0].filePath, entry.filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachRuntime absolutizes a relative pi sessionFile and folds the scanned absolute entry in", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  try {
    const catalog = new SessionCatalog(
      join(dir, "sessions.json"),
      {},
      absolutePathResolver("D:\\Project\\PiDeck"),
    );
    await catalog.load();
    const draft = await catalog.createDraft({
      projectId: "project-1",
      title: "PiDeck agent",
      environment: "native",
    });

    // pi 返回相对 cwd 的 sessionFile（sessionDir 配置为 ".pi/sessions"）
    await catalog.attachRuntime({
      sessionId: draft.id,
      filePath: ".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
      piSessionId: "pi-relative",
    });

    // 后台扫描发现同一文件的绝对路径（修复前这里会产生第二条记录）
    const scanned = summary({
      id: "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
      filePath: "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
      name: "从用户输入推断的会话名",
    });
    const records = await catalog.mergeScanned("project-1", [scanned]);

    assert.equal(records.length, 1);
    assert.equal(records[0].id, draft.id);
    assert.equal(records[0].filePath, scanned.filePath);
    assert.equal(records[0].title, "从用户输入推断的会话名");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureRuntimeTarget absolutizes relative session paths", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
  try {
    const catalog = new SessionCatalog(
      join(dir, "sessions.json"),
      {},
      absolutePathResolver("D:\\Project\\PiDeck"),
    );
    await catalog.load();
    const record = await catalog.ensureRuntimeTarget({
      projectId: "project-1",
      title: "Copied",
      source: "pi",
      environment: "native",
      filePath: ".pi\\sessions\\copied.jsonl",
    });
    assert.equal(record.filePath, "D:\\Project\\PiDeck\\.pi\\sessions\\copied.jsonl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeByProjectId drops every catalog entry for a removed sidebar project", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-remove-project-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    await catalog.createDraft({
      projectId: "gone-project",
      title: "Keep me out",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-gone",
    });
    await catalog.createDraft({
      projectId: "keep-project",
      title: "Stay",
      environment: "native",
      backend: "dsh",
      dshSessionId: "session-keep",
    });
    const removed = await catalog.removeByProjectId("gone-project");
    assert.equal(removed, 1);
    assert.equal(catalog.listEntries().length, 1);
    assert.equal(catalog.listEntries()[0].projectId, "keep-project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nameless scanned summaries keep existing titles and use the file stem for new rows", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-stem-title-"));
  try {
    const catalog = new SessionCatalog(join(dir, "sessions.json"));
    await catalog.load();
    const [named] = await catalog.mergeScanned("project-1", [summary({
      filePath: "C:/sessions/known.jsonl",
      id: "C:/sessions/known.jsonl",
      name: "Saved title",
    })]);
    const [kept] = await catalog.mergeScanned("project-1", [summary({
      filePath: "C:/sessions/known.jsonl",
      id: "C:/sessions/known.jsonl",
      name: undefined,
      preview: "",
      messageCount: 0,
    })]);
    assert.equal(kept.id, named.id);
    assert.equal(kept.title, "Saved title");
    assert.equal(kept.preview, "");

    const records = await catalog.mergeScanned("project-1", [summary({
      filePath: "C:/sessions/2026-08-08T10-47-19-239Z_abc.jsonl",
      id: "C:/sessions/2026-08-08T10-47-19-239Z_abc.jsonl",
      name: undefined,
    })]);
    const fresh = records.find((record) => record.filePath?.includes("2026-08-08T10-47-19-239Z_abc"));
    assert.equal(fresh?.title, "2026-08-08T10-47-19-239Z_abc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parentSessionPath survives reload: getRecord/listEntries rebuild keeps the subagent tree link", async () => {
  const { SessionCatalog } = loadCatalog();
  const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-parent-path-"));
  const filePath = join(dir, "sessions.json");
  try {
    const catalog = new SessionCatalog(filePath);
    await catalog.load();
    await catalog.mergeScanned("project-1", [
      summary({ filePath: "C:/sessions/parent.jsonl", id: "C:/sessions/parent.jsonl", name: "Parent" }),
      summary({
        filePath: "C:/sessions/parent/child.jsonl",
        id: "C:/sessions/parent/child.jsonl",
        name: "Child",
        parentSessionPath: "c:/sessions/parent.jsonl",
      }),
    ]);

    // 重载：模拟重启后从磁盘恢复 entry，再走 getRecord（缓存先回显路径）
    const reloaded = new SessionCatalog(filePath);
    await reloaded.load();
    const entries = reloaded.listEntries().filter((entry) => entry.projectId === "project-1");
    const childEntry = entries.find((entry) => entry.title === "Child");
    assert.ok(childEntry, "child entry restored from disk");
    const record = childEntry ? reloaded.getRecord(childEntry.id) : undefined;
    // 回归：entry 必须持久化 parentSessionPath，否则缓存回显时子会话降级为顶层孤儿
    // 大小写不敏感断言：渲染层 normalizeSessionPathForCompare 比较，功能不受大小写影响
    assert.ok(record?.parentSessionPath);
    assert.equal(
      record?.parentSessionPath?.toLowerCase().replace(/\\/g, "/"),
      "c:/sessions/parent.jsonl",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
