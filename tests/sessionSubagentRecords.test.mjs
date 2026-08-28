/**
 * SessionHistoryReader.readSubagentRecords 行为验证：
 * - 正确解析 subagents:record custom 条目
 * - status 白名单校验（非法值丢弃）
 * - 非 subagents:record 的 custom 条目不混入
 * - 损坏行忽略
 * - 排序（startedAt 降序）
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