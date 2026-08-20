import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function session(id, projectId, title = id) {
  return {
    id,
    projectId,
    title,
    environment: "native",
    source: "pi",
    createdAt: 1,
    updatedAt: 1,
  };
}

function runtime(sessionId, agentId, projectId, generation = 1, status = "idle") {
  return {
    sessionId,
    agentId,
    runtimeGeneration: generation,
    projectId,
    cwd: `C:/${projectId}`,
    status,
    createdAt: generation,
  };
}

function runtimeEvent(sessionId, agentId, generation, sourceChannel, payload, kind = "event") {
  return {
    kind,
    sessionId,
    agentId,
    runtimeGeneration: generation,
    sourceChannel,
    payload,
  };
}

test("agent inventory is a read-only projection of canonical Session runtimes", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a", "Stable title")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
  ]);

  assert.equal(store.get(atoms.agentByIdAtomFamily("agent-a")).title, "Stable title");
  assert.equal(
    store.get(atoms.agentsByProjectIdAtomFamily("project-a")).map((agent) => agent.id).join(","),
    "agent-a",
  );
  assert.equal(atoms.replaceAgentInventoryAtom, undefined);
  assert.equal(atoms.upsertAgentInventoryAtom, undefined);
});

test("agent inventory keeps the same array when runtime identity is unchanged", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a", "Stable title")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
  ]);
  const first = store.get(atoms.agentInventoryAtom);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:state",
    {
      id: "agent-a",
      projectId: "project-a",
      cwd: "C:/project-a",
      title: "Stable title",
      status: "idle",
      createdAt: 1,
    },
  ));
  const second = store.get(atoms.agentInventoryAtom);
  // 无实质字段变化时不得换新数组：App 的 useEffect([agents]) / displayAgents
  // 会跟着每帧 setState，把设置弹层和关窗点死。
  assert.equal(second, first);
});

test("runtime capabilities merge in the canonical Session runtime without message data", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
  ]);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { modelName: "Model A", isStreaming: true } },
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { isExecutingTool: true } },
  ));

  const capability = store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-a"));
  assert.equal(capability.modelName, "Model A");
  assert.equal(capability.isStreaming, true);
  assert.equal(capability.isExecutingTool, true);
  assert.equal("messages" in capability, false);
  assert.equal(atoms.applyRuntimeCapabilityAtom, undefined);
});

test("project capability selectors ignore unrelated canonical Session updates", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-b",
    sessions: [session("session-b", "project-b")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a"),
    runtime("session-b", "agent-b", "project-b"),
  ]);
  for (const [sessionId, agentId, modelName] of [
    ["session-a", "agent-a", "Model A"],
    ["session-b", "agent-b", "Model B"],
  ]) {
    store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
      sessionId,
      agentId,
      1,
      "agents:runtime-state",
      { agentId, state: { modelName } },
    ));
  }

  const projectAAtom = atoms.runtimeCapabilitiesByProjectIdAtomFamily("project-a");
  const before = store.get(projectAAtom);
  let notifications = 0;
  const unsubscribe = store.sub(projectAAtom, () => { notifications += 1; });

  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-b",
    "agent-b",
    1,
    "agents:runtime-state",
    { agentId: "agent-b", state: { isStreaming: true } },
  ));
  assert.equal(store.get(projectAAtom), before);
  assert.equal(notifications, 0);

  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { isStreaming: true } },
  ));
  assert.notEqual(store.get(projectAAtom), before);
  assert.equal(notifications, 1);
  unsubscribe();
});

test("replacement binding clears stale runtime state before new events arrive", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  // 旧绑定 agent-a（generation 1）带旧模型 state
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a", 1),
  ]);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    1,
    "agents:runtime-state",
    { agentId: "agent-a", state: { modelName: "Old Model", provider: "old" } },
  ));
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "Old Model");

  // 新绑定 agent-b（generation 2）attach：只推 agents:state（tab 无 state 字段），
  // 模拟懒启动后 applyPreferences 的 runtime-state 事件尚未到达的窗口期。
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    2,
    "agents:state",
    {
      id: "agent-b",
      projectId: "project-a",
      cwd: "C:/project-a",
      title: "replacement",
      status: "idle",
      createdAt: 2,
    },
  ));
  // bindingChanged 必须清空残留 state：底栏 state?.modelName 回退到 record，而不是旧模型。
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].agentId, "agent-b");
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state, undefined);

  // 新绑定收到 runtime-state 事件后 state 正常填充
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    2,
    "agents:runtime-state",
    { agentId: "agent-b", state: { modelName: "New Model", provider: "new" } },
  ));
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "New Model");
});

test("late events from runtime A cannot revive its inventory or capabilities after replacement B", () => {
  const store = createStore();
  store.set(atoms.replaceProjectSessionsAtom, {
    projectId: "project-a",
    sessions: [session("session-a", "project-a")],
  });
  store.set(atoms.replaceSessionRuntimesAtom, [
    runtime("session-a", "agent-a", "project-a", 2),
  ]);
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    3,
    "agents:state",
    {
      id: "agent-b",
      projectId: "project-a",
      cwd: "C:/project-a",
      title: "replacement",
      status: "idle",
      createdAt: 3,
    },
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-b",
    3,
    "agents:runtime-state",
    { agentId: "agent-b", state: { modelName: "B", isStreaming: true } },
  ));

  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    2,
    "agents:state",
    { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "old", status: "closed", createdAt: 1 },
  ));
  store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(
    "session-a",
    "agent-a",
    2,
    "agents:detach",
    undefined,
    "detach",
  ));

  assert.equal(store.get(atoms.agentInventoryAtom).map((agent) => agent.id).join(","), "agent-b");
  assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-a")), undefined);
  assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-b")).modelName, "B");
});
