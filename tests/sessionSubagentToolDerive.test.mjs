/**
 * subagent 工具链（nicobailon pi-subagents）兼容验证：
 * - 前台派发（agent+task、无 action/async）→ running，配对 toolResult → completed/error
 *   且 result 携带报告全文
 * - action 管理查询 / 工作流脚本派发 / 后台派发（async:true）不推导（后台由
 *   subagent-async widget 实时呈现，避免 id 空间不同的双行）
 * - parseSubagentAsyncSnapshot：PI_SUBAGENT_ASYNC_JSON 快照 → 条目（state 映射、
 *   非 acp/非快照载荷 fail-soft）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { deriveSubagentToolEntries, deriveToolSubagentEntries } = loadTsCommonJs(
  "src/main/pi/derivedSubagents.ts",
);
const { parseSubagentAsyncSnapshot } = loadTsCommonJs(
  "src/renderer/src/hooks/useSessionSubagents.ts",
  {
    stubs: {
      jotai: { useAtomValue: () => undefined },
      react: { useEffect: () => {}, useMemo: (fn) => fn(), useState: (i) => [i, () => {}] },
      "../desktopApi": { desktopApi: { sessions: { listSessionSubagents: async () => [] } } },
      "../atoms": { sessionRuntimeUiBySessionIdAtomFamily: () => undefined },
    },
  },
);

let seq = 0;
function entryId() {
  seq += 1;
  return `e${seq}`;
}

function toolCallEntry({ toolCallId, args, timestamp, name = "subagent" }) {
  return {
    type: "message",
    id: entryId(),
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    },
  };
}

function toolResultEntry({ toolCallId, text, timestamp, isError, toolName = "subagent" }) {
  return {
    type: "message",
    id: entryId(),
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: isError === true,
      content: [{ type: "text", text }],
    },
  };
}

const T0 = "2026-08-02T11:46:21.399Z";
const T1 = "2026-08-02T11:47:46.554Z";
const CALL_ID = "call_5809c5095c764e339f6b90e1";
const REPORT = "# Research: DeepSeek 最新 AI 模型信息\n\n## 摘要\n……";

test("derive: 前台派发 + 配对结果 → completed 且 result 携带报告全文", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({
      toolCallId: CALL_ID,
      args: { agent: "researcher", task: "查询 DeepSeek 最新模型信息" },
      timestamp: T0,
    }),
    toolResultEntry({ toolCallId: CALL_ID, text: REPORT, timestamp: T1 }),
  ]);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.id, CALL_ID);
  assert.equal(entry.type, "researcher");
  assert.equal(entry.description, "查询 DeepSeek 最新模型信息");
  assert.equal(entry.status, "completed");
  assert.equal(entry.result, REPORT);
  assert.equal(entry.startedAt, Date.parse(T0));
  assert.equal(entry.completedAt, Date.parse(T1));
  assert.equal(entry.source, "toolcall");
  assert.equal(entry.via, "pi-subagents-tool");
});

test("derive: isError 结果 → error", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
    toolResultEntry({ toolCallId: CALL_ID, text: "boom", timestamp: T1, isError: true }),
  ]);
  assert.equal(entries[0].status, "error");
  assert.equal(entries[0].result, "boom");
});

test("derive: 未配对结果的派发保持 running（运行中/被杀由活性降级处理）", () => {
  const entries = deriveSubagentToolEntries([
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "worker", task: "T" }, timestamp: T0 }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "running");
});

test("derive: action 查询 / 工作流派发 / 后台派发均不推导", () => {
  const entries = deriveSubagentToolEntries([
    // action 管理查询（list/status 等）
    toolCallEntry({ toolCallId: "call_list", args: { action: "list" }, timestamp: T0 }),
    // 带 agent 但同时带 action（agent 管理动作）
    toolCallEntry({ toolCallId: "call_act", args: { action: "stop", agent: "worker", runId: "r1" }, timestamp: T0 }),
    // 工作流脚本派发
    toolCallEntry({ toolCallId: "call_wf", args: { agent: "worker", task: "T", workflowScript: "return 1" }, timestamp: T0 }),
    // 后台派发：运行态由 subagent-async widget 呈现
    toolCallEntry({ toolCallId: "call_async", args: { agent: "worker", task: "T", async: true }, timestamp: T0 }),
  ]);
  // VM realm 数组原型不同，deepEqual 不可用
  assert.equal(entries.length, 0);
});

test("deriveToolSubagentEntries: acp 与 subagent 两条链并存拼接", () => {
  const entries = deriveToolSubagentEntries([
    toolCallEntry({
      toolCallId: "acp_delegate_1", name: "acp_delegate",
      args: { agent: "worker", task: "acp task" }, timestamp: T0,
    }),
    toolCallEntry({ toolCallId: CALL_ID, args: { agent: "researcher", task: "sub task" }, timestamp: T0 }),
  ]);
  const ids = entries.map((e) => e.id).sort().join(",");
  assert.equal(ids, ["acp_delegate_1", CALL_ID].sort().join(","));
  const vias = entries.map((e) => e.via).sort().join(",");
  assert.equal(vias, ["acp-delegate", "pi-subagents-tool"].sort().join(","));
});

test("parseSubagentAsyncSnapshot: 快照行映射为条目（state → status）", () => {
  const snapshot = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1700000000000,
    runs: [
      { id: "async-1", kind: "async-job", label: "worker", state: "running", startedAt: 1700000001000 },
      { id: "async-2", kind: "async-job", label: "reviewer", state: "complete", startedAt: 1700000002000, endedAt: 1700000102000 },
      { id: "async-3", kind: "async-job", label: "scout", state: "failed" },
      { id: "async-4", kind: "async-job", label: "delegate", state: "partial" },
      { id: "async-5", kind: "async-job", label: "planner", state: "stopped" },
      { id: "async-6", kind: "async-job", state: "running" }, // 无 label
    ],
  };
  const entries = parseSubagentAsyncSnapshot([
    "其他无关行",
    `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`,
  ]);
  assert.equal(entries.length, 6);
  assert.equal(entries[0].status, "running");
  assert.equal(entries[1].status, "completed");
  assert.equal(entries[1].completedAt, 1700000102000);
  assert.equal(entries[2].status, "error");
  // partial（部分失败）按失败类呈现
  assert.equal(entries[3].status, "error");
  assert.equal(entries[4].status, "stopped");
  // 无 label 回退 "subagent"
  assert.equal(entries[5].type, "subagent");
  for (const entry of entries) {
    assert.equal(entry.source, "bridge");
    assert.equal(entry.via, "pi-subagents-tool");
  }
});

test("parseSubagentAsyncSnapshot: 非快照载荷/损坏 JSON/空输入 fail-soft", () => {
  // VM realm 数组原型不同，deepEqual 不可用
  assert.equal(parseSubagentAsyncSnapshot(undefined).length, 0);
  assert.equal(parseSubagentAsyncSnapshot([]).length, 0);
  assert.equal(parseSubagentAsyncSnapshot(["PI_SUBAGENT_ASYNC_JSON:not-json{"]).length, 0);
  assert.equal(parseSubagentAsyncSnapshot([
    `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "other" })}`,
  ]).length, 0);
});
