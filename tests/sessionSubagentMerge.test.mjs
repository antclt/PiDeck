/**
 * useSessionSubagents.mergeSubagentEntries 三源合并行为测试：
 * - record 为底座，桥接运行中覆写
 * - 桥接 0 默认值不得覆盖 record 真实 toolUses/tokens
 * - record 终态不被桥接倒覆
 * - 桥接独有条目保留
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mergeSubagentEntries } = loadTsCommonJs(
  "src/renderer/src/hooks/useSessionSubagents.ts",
  {
    stubs: {
      jotai: { useAtomValue: () => undefined },
      react: {
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useState: (initial) => [initial, () => {}],
      },
      "../desktopApi": {
        desktopApi: { sessions: { listSessionSubagents: async () => [] } },
      },
      "../atoms": { sessionRuntimeUiBySessionIdAtomFamily: () => undefined },
    },
  },
);

function record(overrides) {
  return {
    id: "a1",
    type: "Explore",
    description: "d",
    status: "completed",
    source: "record",
    toolUses: 5,
    tokens: 300,
    startedAt: 1700000000000,
    ...overrides,
  };
}

function bridgeLine(agents) {
  return [
    JSON.stringify({ v: 1, kind: "snapshot", pluginActive: true, agents }),
  ];
}

test("merge: bridge 0 defaults do not clobber record toolUses/tokens", () => {
  const { merged } = mergeSubagentEntries(
    [record({ status: "running" })],
    bridgeLine([{ id: "a1", type: "Explore", description: "d", status: "running", toolUses: 0, tokens: 0 }]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].toolUses, 5);
  assert.equal(merged[0].tokens, 300);
  assert.equal(merged[0].status, "running");
});

test("merge: bridge positive counts update record while running", () => {
  const { merged } = mergeSubagentEntries(
    [record({ status: "running", toolUses: 2 })],
    bridgeLine([{ id: "a1", type: "Explore", description: "d", status: "running", toolUses: 7, tokens: 80 }]),
  );
  assert.equal(merged[0].toolUses, 7);
  assert.equal(merged[0].tokens, 80);
});

test("merge: terminal record status is never overwritten by bridge", () => {
  const { merged } = mergeSubagentEntries(
    [record({ status: "completed", toolUses: 5 })],
    bridgeLine([{ id: "a1", type: "Explore", description: "d", status: "running", toolUses: 9 }]),
  );
  assert.equal(merged[0].status, "completed");
  assert.equal(merged[0].toolUses, 5);
});

test("merge: no bridge snapshot → pluginActive undefined (three-state)", () => {
  const { merged, pluginActive } = mergeSubagentEntries(
    [record({ id: "a1" })],
    undefined,
  );
  // 无桥接快照（历史会话/扩展未推送）≠ 插件不在位：UI 应显示中性空态而非“未检测到插件”
  assert.equal(merged.length, 1);
  assert.equal(pluginActive, undefined);
});

test("merge: bridge snapshot with pluginActive false stays false", () => {
  const { merged, pluginActive } = mergeSubagentEntries(
    [],
    [JSON.stringify({ v: 1, kind: "snapshot", pluginActive: false, agents: [] })],
  );
  assert.equal(merged.length, 0);
  assert.equal(pluginActive, false);
});

test("merge: bridge-only entries are kept (not yet persisted)", () => {
  const { merged, pluginActive } = mergeSubagentEntries(
    [],
    bridgeLine([{ id: "b2", type: "code", description: "new", status: "running", toolUses: 1 }]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "b2");
  assert.equal(merged[0].source, "bridge");
  assert.equal(pluginActive, true);
});

test("merge: active entries sort before terminal entries", () => {
  const { merged } = mergeSubagentEntries(
    [record({ id: "done", status: "completed", startedAt: 1700000005000 })],
    bridgeLine([{ id: "live", type: "code", description: "d", status: "running", startedAt: 1700000001000 }]),
  );
  assert.equal(merged[0].id, "live");
  assert.equal(merged[1].id, "done");
});
