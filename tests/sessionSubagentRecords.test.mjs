/**
 * SessionHistoryReader.readSubagentRecords 行为验证：
 * - 正确解析 subagents:record custom 条目
 * - status 白名单校验（非法值丢弃）
 * - 非 subagents:record 的 custom 条目不混入
 * - 损坏行忽略
 * - 排序（startedAt 降序）
 * - fork 旁支上的 record 不丢失（全量条目表扫描）
 * - 同一子代理 id 多条 record 时保留文件序最新一条
 * - start 锚点（pi-deck-subagent-start）残留时合成 stopped；被 record 覆盖时以 record 为准
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs(
  "src/main/pi/SessionHistoryReader.ts",
);

function createReader() {
  return new SessionHistoryReader({
    toHostPath: (sessionPath) => sessionPath,
    convertMessages: (_agentId, rawMessages, _entryIds) =>
      rawMessages.map((m, i) => ({ id: `msg-${i}`, role: m.role, text: "" })),
    trimMessages: (messages) => messages,
    translate: () => "",
  });
}

function writeSession(filePath, contents) {
  writeFileSync(filePath, contents, "utf8");
}

const fixture = JSON.stringify({
  type: "session",
  id: "session-1",
  cwd: "/tmp",
  timestamp: new Date().toISOString(),
}) + "\n" +
  JSON.stringify({
    type: "message",
    id: "u1",
    parentId: "session-1",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  }) + "\n" +
  JSON.stringify({
    type: "message",
    id: "a1",
    parentId: "u1",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "rec-1",
    parentId: "a1",
    data: {
      id: "agent-abc12345",
      type: "Explore",
      description: "Find auth files",
      status: "completed",
      result: "Found 3 auth files",
      startedAt: 1700000000000,
      completedAt: 1700000005000,
    },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "rec-2",
    parentId: "rec-1",
    data: {
      id: "agent-def67890",
      type: "code",
      description: "Implement login",
      status: "running",
      startedAt: 1700000010000,
    },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "rec-3",
    parentId: "rec-2",
    data: {
      id: "agent-ghi11111",
      type: "Explore",
      description: "Status error",
      status: "error",
      error: "timeout",
      startedAt: 1700000020000,
      completedAt: 1700000030000,
    },
  }) + "\n" +
  // Bad entry: invalid status
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "rec-4",
    parentId: "rec-3",
    data: {
      id: "agent-bad",
      type: "code",
      description: "bad status",
      status: "INVALID",
      startedAt: 1700000040000,
    },
  }) + "\n" +
  // Non-subagent custom entry (child-session) — should be ignored
  JSON.stringify({
    type: "custom",
    customType: "pi-subagents.child-session",
    id: "rec-5",
    parentId: "rec-4",
    data: { schemaVersion: 1 },
  }) + "\n";

test("readSubagentRecords parses valid subagents:record entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-subagent-records-"));
  const sessionPath = join(dir, "session.jsonl");
  try {
    writeSession(sessionPath, fixture);
    const reader = createReader();
    const entries = await reader.readSubagentRecords(sessionPath);

    // 3 valid entries (rec-4 excluded for bad status, rec-5 excluded for wrong customType)
    assert.equal(entries.length, 3);

    // Sorted by startedAt desc
    assert.equal(entries[0].id, "agent-ghi11111"); // 1700000020000
    assert.equal(entries[1].id, "agent-def67890"); // 1700000010000
    assert.equal(entries[2].id, "agent-abc12345"); // 1700000000000

    // Check field projection
    const completedEntry = entries[2]; // agent-abc12345
    assert.equal(completedEntry.type, "Explore");
    assert.equal(completedEntry.description, "Find auth files");
    assert.equal(completedEntry.status, "completed");
    assert.equal(completedEntry.result, "Found 3 auth files");
    assert.equal(completedEntry.startedAt, 1700000000000);
    assert.equal(completedEntry.completedAt, 1700000005000);
    assert.equal(completedEntry.source, "record");

    const runningEntry = entries[1]; // agent-def67890
    assert.equal(runningEntry.status, "running");
    assert.equal(runningEntry.result, undefined);
    assert.equal(runningEntry.completedAt, undefined);

    const errorEntry = entries[0]; // agent-ghi11111
    assert.equal(errorEntry.status, "error");
    assert.equal(errorEntry.error, "timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSubagentRecords returns empty for session with no subagent records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-subagent-empty-"));
  const sessionPath = join(dir, "session.jsonl");
  try {
    const noRecords = JSON.stringify({
      type: "session",
      id: "s1",
      cwd: "/tmp",
      timestamp: new Date().toISOString(),
    }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: "s1",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }) + "\n";
    writeSession(sessionPath, noRecords);
    const reader = createReader();
    const entries = await reader.readSubagentRecords(sessionPath);
    assert.equal(entries.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// fork 场景：分叉点 a1 有两个孩子（旧链 abandoned、新链 active）。
// 旧链上产生的 subagents:record 不在 activeBranch，但属于会话运行审计，必须读出。
const forkedSession = JSON.stringify({
  type: "session",
  id: "fs1",
  cwd: "/tmp",
  timestamp: new Date().toISOString(),
}) + "\n" +
  JSON.stringify({
    type: "message",
    id: "fu1",
    parentId: "fs1",
    message: { role: "user", content: [{ type: "text", text: "run agents" }] },
  }) + "\n" +
  // 分叉点：assistant a1
  JSON.stringify({
    type: "message",
    id: "fa1",
    parentId: "fu1",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  }) + "\n" +
  // 旧链（后被 fork 抛弃）：user 消息 + 子代理完成 record
  JSON.stringify({
    type: "message",
    id: "fold-u1",
    parentId: "fa1",
    message: { role: "user", content: [{ type: "text", text: "old branch" }] },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "frec-1",
    parentId: "fold-u1",
    data: {
      id: "agent-folded99",
      type: "general-purpose",
      description: "agent on abandoned branch",
      status: "completed",
      result: "old branch result",
      startedAt: 1700000100000,
      completedAt: 1700000110000,
    },
  }) + "\n" +
  // 新链（活动分支）：用户从 a1 fork 重发
  JSON.stringify({
    type: "message",
    id: "fnew-u1",
    parentId: "fa1",
    message: { role: "user", content: [{ type: "text", text: "new branch" }] },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "pi-deck-todo",
    id: "ftodo-1",
    parentId: "fnew-u1",
    data: { activePlan: [] },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "frec-2",
    parentId: "ftodo-1",
    data: {
      id: "agent-active88",
      type: "code",
      description: "agent on active branch",
      status: "completed",
      startedAt: 1700000200000,
      completedAt: 1700000210000,
    },
  }) + "\n";

test("readSubagentRecords keeps records on abandoned fork branches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-subagent-fork-"));
  const sessionPath = join(dir, "session.jsonl");
  try {
    writeSession(sessionPath, forkedSession);
    const reader = createReader();
    const entries = await reader.readSubagentRecords(sessionPath);

    // 旁支 record（agent-folded99）不在 activeBranch，但必须读出
    assert.equal(entries.length, 2);
    const ids = entries.map((e) => e.id).sort();
    assert.equal(ids.join(","), "agent-active88,agent-folded99");

    const folded = entries.find((e) => e.id === "agent-folded99");
    assert.equal(folded.status, "completed");
    assert.equal(folded.result, "old branch result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSubagentRecords keeps the latest record per agent id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-subagent-dedup-"));
  const sessionPath = join(dir, "session.jsonl");
  try {
    const content = JSON.stringify({
      type: "session",
      id: "ds1",
      cwd: "/tmp",
      timestamp: new Date().toISOString(),
    }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "du1",
        parentId: "ds1",
        message: { role: "user", content: [{ type: "text", text: "resume agent" }] },
      }) + "\n" +
      // 同一 agent id 的第一条 record（resume 前的终态，文件序靠前）
      JSON.stringify({
        type: "custom",
        customType: "subagents:record",
        id: "drec-1",
        parentId: "du1",
        data: {
          id: "agent-sameid11",
          type: "code",
          description: "first run",
          status: "completed",
          result: "first result",
          startedAt: 1700000000000,
          completedAt: 1700000005000,
        },
      }) + "\n" +
      // 同一 agent id 的第二条 record（resume 后再完成，文件序靠后 → 应胜出）
      JSON.stringify({
        type: "custom",
        customType: "subagents:record",
        id: "drec-2",
        parentId: "drec-1",
        data: {
          id: "agent-sameid11",
          type: "code",
          description: "resumed run",
          status: "completed",
          result: "resumed result",
          startedAt: 1700000090000,
          completedAt: 1700000095000,
        },
      }) + "\n" +
      // 另一个独立子代理
      JSON.stringify({
        type: "custom",
        customType: "subagents:record",
        id: "drec-3",
        parentId: "drec-2",
        data: {
          id: "agent-other2222",
          type: "Explore",
          description: "other agent",
          status: "completed",
          startedAt: 1700000050000,
          completedAt: 1700000060000,
        },
      }) + "\n";
    writeSession(sessionPath, content);
    const reader = createReader();
    const entries = await reader.readSubagentRecords(sessionPath);

    // 同 id 去重后共 2 条
    assert.equal(entries.length, 2);
    const resumed = entries.find((e) => e.id === "agent-sameid11");
    // 文件序靠后的 record 胜出：result/startedAt 都是第二次运行
    assert.equal(resumed.description, "resumed run");
    assert.equal(resumed.result, "resumed result");
    assert.equal(resumed.startedAt, 1700000090000);
    // 排序仍按 startedAt 降序：resumed（09:00）在前，other（05:00）在后
    assert.equal(entries[0].id, "agent-sameid11");
    assert.equal(entries[1].id, "agent-other2222");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// start 锚点：created 时落盘的 pi-deck-subagent-start 条目。
// 场景 1：子代理运行中被会话重启终止 → 只剩锚点，合成 stopped（保留审计痕迹）。
// 场景 2：子代理正常完成 → 锚点被更晚的 record 覆盖，以 record 为准。
const startAnchorSession = JSON.stringify({
  type: "session",
  id: "ss1",
  cwd: "/tmp",
  timestamp: new Date().toISOString(),
}) + "\n" +
  JSON.stringify({
    type: "message",
    id: "su1",
    parentId: "ss1",
    message: { role: "user", content: [{ type: "text", text: "spawn" }] },
  }) + "\n" +
  // 被 termination 杀掉的子代理：只有 start 锚点，无 record
  JSON.stringify({
    type: "custom",
    customType: "pi-deck-subagent-start",
    id: "srec-1",
    parentId: "su1",
    data: {
      id: "agent-killed77",
      type: "Explore",
      description: "killed by restart",
      startedAt: 1700000300000,
    },
  }) + "\n" +
  // 正常完成的子代理：start 锚点（文件序靠前）+ record（文件序靠后）
  JSON.stringify({
    type: "custom",
    customType: "pi-deck-subagent-start",
    id: "srec-2",
    parentId: "srec-1",
    data: {
      id: "agent-finished8",
      type: "code",
      description: "finished normally",
      startedAt: 1700000400000,
    },
  }) + "\n" +
  JSON.stringify({
    type: "custom",
    customType: "subagents:record",
    id: "srec-3",
    parentId: "srec-2",
    data: {
      id: "agent-finished8",
      type: "code",
      description: "finished normally",
      status: "completed",
      result: "done",
      startedAt: 1700000400000,
      completedAt: 1700000410000,
    },
  }) + "\n";

test("readSubagentRecords synthesizes stopped from residual start anchors and prefers record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-subagent-start-"));
  const sessionPath = join(dir, "session.jsonl");
  try {
    writeSession(sessionPath, startAnchorSession);
    const reader = createReader();
    const entries = await reader.readSubagentRecords(sessionPath);

    assert.equal(entries.length, 2);

    // 只剩锚点的子代理：合成 stopped（无 result/error/completedAt）
    const killed = entries.find((e) => e.id === "agent-killed77");
    assert.equal(killed.status, "stopped");
    assert.equal(killed.type, "Explore");
    assert.equal(killed.description, "killed by restart");
    assert.equal(killed.startedAt, 1700000300000);
    assert.equal(killed.result, undefined);
    assert.equal(killed.completedAt, undefined);

    // 有 record 的子代理：record 覆盖锚点，状态为真实终态
    const finished = entries.find((e) => e.id === "agent-finished8");
    assert.equal(finished.status, "completed");
    assert.equal(finished.result, "done");
    assert.equal(finished.completedAt, 1700000410000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});