import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  parseHeaderLine,
  isForeignRootSession,
  firstZstdFrameEnd,
  listForeignSessionsFromDisk,
  scanDshSessionHeaders,
} = loadTsCommonJs("src/main/dsh/dshForeignSessionScan.ts");
const {
  parseProjectionTitles,
  titleFromProjectionRecord,
} = loadTsCommonJs("src/main/dsh/dshProjectionCache.ts");
const {
  fallbackSessionTitle,
  foldLoggedSessionTitle,
} = loadTsCommonJs("src/main/dsh/dshSessionTitleFold.ts");
const { workspaceDirFor } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");
const { DshHost } = loadTsCommonJs("src/main/dsh/DshHost.ts");

function headerJson(overrides = {}) {
  return JSON.stringify({
    type: "session",
    version: 0,
    id: "session-root-1",
    createdAt: 1,
    cwd: "D:\\project\\alpha",
    delegationDepth: 0,
    ...overrides,
  });
}

test("parseHeaderLine accepts a session header and ignores later lines", () => {
  const parsed = parseHeaderLine(`${headerJson()}\n{"type":"user"}\n`, 99);
  assert.equal(parsed.id, "session-root-1");
  assert.equal(parsed.cwd, "D:\\project\\alpha");
  assert.equal(parsed.delegationDepth, 0);
  assert.equal(parsed.updatedAt, 99);
});

test("parseHeaderLine extracts the persisted agent preset (会话「模式」)", () => {
  const parsed = parseHeaderLine(headerJson({ agentPreset: "cordis" }), 1);
  assert.equal(parsed.agentPreset, "cordis");
  // 缺省 header（老版本 host 会话）不携带该字段，解析结果保持 undefined
  assert.equal(parseHeaderLine(headerJson(), 1).agentPreset, undefined);
});

test("parseHeaderLine rejects non-session first lines", () => {
  assert.equal(parseHeaderLine("not-json", 1), undefined);
  assert.equal(parseHeaderLine(JSON.stringify({ type: "user", id: "x" }), 1), undefined);
  assert.equal(parseHeaderLine(JSON.stringify({ type: "session" }), 1), undefined);
});

test("isForeignRootSession drops subagents and forked children", () => {
  assert.equal(isForeignRootSession({ id: "a", updatedAt: 1 }), true);
  assert.equal(isForeignRootSession({ id: "a", updatedAt: 1, origin: "subagent" }), false);
  assert.equal(isForeignRootSession({ id: "a", updatedAt: 1, parentSession: "session-parent" }), false);
  assert.equal(isForeignRootSession({ id: "a", updatedAt: 1, delegationDepth: 1 }), false);
});

test("firstZstdFrameEnd locates a real checksummed header frame", () => {
  const frame = zstdCompressSync(Buffer.from(`${headerJson()}\n`, "utf8"));
  const end = firstZstdFrameEnd(frame);
  assert.equal(end, frame.length);
  assert.equal(firstZstdFrameEnd(Buffer.from("not-zstd")), undefined);
  assert.equal(firstZstdFrameEnd(frame.subarray(0, 8)), undefined);
});

/** 在临时 DSH_HOME 写下 header（zstd 或明文 jsonl）；extraLines 可追加 session/title 等事件。 */
function writeSession(home, cwd, sessionId, headerOverrides, encoding = "zstd", extraLines = []) {
  const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
  mkdirSync(dir, { recursive: true });
  const line = [`${headerJson({ id: sessionId, cwd, ...headerOverrides })}`, ...extraLines, ""].join("\n");
  if (encoding === "zstd") {
    writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(line, "utf8")));
  } else {
    writeFileSync(join(dir, "session.jsonl"), line);
  }
}

test("parseProjectionTitles reads official session_projcache title.val rows", () => {
  const titles = parseProjectionTitles(JSON.stringify({
    unit: "session_projcache",
    tables: {
      sessions: {
        "session-root-a": {
          identity: { cwd: "D:/project/alpha" },
          rows: { title: { ver: 1, seq: 1, val: "你好" } },
        },
        "session-blank": {
          rows: { title: { ver: 1, seq: 1, val: "   " } },
        },
      },
    },
  }));
  assert.equal(titles.get("session-root-a"), "你好");
  assert.equal(titles.has("session-blank"), false);
  assert.equal(titleFromProjectionRecord({ rows: { title: { val: 12 } } }), undefined);
});

test("listForeignSessionsFromDisk returns root sessions and skips subagents", () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-scan-"));
  try {
    writeSession(home, "D:/project/alpha", "session-root-a", {});
    writeSession(home, "D:/project/alpha", "session-child", {
      origin: "subagent",
      parentSession: "session-root-a",
      delegationDepth: 1,
    });
    writeSession(home, "D:/project/beta", "session-plain", {}, "jsonl");
    const items = listForeignSessionsFromDisk(home);
    const ids = items.map((item) => item.dshSessionId).sort();
    assert.equal(ids.join(","), "session-plain,session-root-a");
    const alpha = items.find((item) => item.dshSessionId === "session-root-a");
    assert.equal(alpha.cwd, "D:/project/alpha");
    assert.equal(typeof alpha.updatedAt, "number");
    assert.equal(alpha.title, undefined, "空日志没有 session/title 也没有首条提示时不得编造标题");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listForeignSessionsFromDisk passes the persisted agent preset through", () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-preset-"));
  try {
    writeSession(home, "D:/project/alpha", "session-preset-a", { agentPreset: "minimal" });
    writeSession(home, "D:/project/alpha", "session-legacy", {});
    const items = listForeignSessionsFromDisk(home);
    const preset = items.find((item) => item.dshSessionId === "session-preset-a");
    assert.equal(preset.agentPreset, "minimal");
    // 老版本 host 的会话 header 没有该字段：item 不携带（保持 undefined）
    const legacy = items.find((item) => item.dshSessionId === "session-legacy");
    assert.equal(legacy.agentPreset, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("foldLoggedSessionTitle prefers last session/title then first-prompt fallback", () => {
  assert.equal(fallbackSessionTitle("几个问题需要修复，1 现在模型 自动重试失败"), "几个问题需要修复，1 现在模");
  const folded = foldLoggedSessionTitle([
    headerJson({ id: "session-root-a" }),
    JSON.stringify({
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "几个问题需要修复，1 现在模型 自动重试失败" }],
      },
    }),
    JSON.stringify({ type: "session/title", data: { title: "静态 Loader 条目" } }),
    JSON.stringify({ type: "session/title", data: { title: "你好" } }),
  ].join("\n"));
  assert.equal(folded, "你好");
});

test("listForeignSessionsFromDisk folds session/title from the log when cache is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-log-title-"));
  try {
    writeSession(home, "D:/project/alpha", "session-root-a", {}, "jsonl", [
      JSON.stringify({
        type: "user/message",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "几个问题需要修复" }],
        },
      }),
      JSON.stringify({ type: "session/title", data: { title: "静态 Loader 条目" } }),
    ]);
    const items = listForeignSessionsFromDisk(home);
    assert.equal(items[0].title, "静态 Loader 条目");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listForeignSessionsFromDisk uses first-prompt fallback when the log has no session/title", () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-fallback-"));
  try {
    writeSession(home, "D:/project/alpha", "session-root-a", {}, "zstd", [
      JSON.stringify({
        type: "user/message",
        data: {
          source: { kind: "user" },
          content: [{ type: "text", text: "几个问题需要修复，1 现在模型 自动重试失败" }],
        },
      }),
    ]);
    const items = listForeignSessionsFromDisk(home);
    assert.equal(items[0].title, "几个问题需要修复，1 现在模");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listForeignSessionsFromDisk attaches official projection-cache titles", () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-title-"));
  try {
    writeSession(home, "D:/project/alpha", "session-root-a", {});
    mkdirSync(join(home, "storages"), { recursive: true });
    writeFileSync(join(home, "storages", "session_projcache.json"), JSON.stringify({
      unit: "session_projcache",
      tables: {
        sessions: {
          "session-root-a": {
            identity: { cwd: "D:/project/alpha" },
            rows: { title: { ver: 1, seq: 12, val: "你好" } },
          },
        },
      },
    }));
    const items = listForeignSessionsFromDisk(home);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "你好");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("scan skips a missing sessions tree without throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-empty-"));
  try {
    assert.equal(scanDshSessionHeaders(home).length, 0);
    assert.equal(listForeignSessionsFromDisk(join(home, "missing")).length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("DshHost.listForeignSessions / listSessionIds read disk without starting host", async () => {
  const home = mkdtempSync(join(tmpdir(), "pideck-dsh-foreign-host-"));
  try {
    writeSession(home, "D:/project/alpha", "session-root-a", {});
    writeSession(home, "D:/project/alpha", "session-child", {
      origin: "subagent",
      parentSession: "session-root-a",
      delegationDepth: 1,
    });
    const host = new DshHost(
      () => join(home, "userData"),
      () => home,
      () => undefined,
      () => home,
    );
    assert.equal(host.isStarted(), false);
    const foreign = await host.listForeignSessions();
    const ids = await host.listSessionIds();
    assert.equal(host.isStarted(), false, "列清单不得 fork host，否则会抢 dsh-web 的 DSH_HOME");
    assert.equal(foreign.map((item) => item.dshSessionId).join(","), "session-root-a");
    assert.equal(ids.sort().join(","), "session-child,session-root-a");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
