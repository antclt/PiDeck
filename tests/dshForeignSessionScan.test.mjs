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

/** 在临时 DSH_HOME 写下 header（zstd 或明文 jsonl）。 */
function writeSession(home, cwd, sessionId, headerOverrides, encoding = "zstd") {
  const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
  mkdirSync(dir, { recursive: true });
  const line = `${headerJson({ id: sessionId, cwd, ...headerOverrides })}\n`;
  if (encoding === "zstd") {
    writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(line, "utf8")));
  } else {
    writeFileSync(join(dir, "session.jsonl"), line);
  }
}

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
