import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const extensionPath = "resources/extensions/pi-deck-todo.ts";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compileExtension() {
  const source = readFileSync(extensionPath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: extensionPath,
  }).outputText;
  const Type = {
    Object: (properties) => ({ properties }),
    Optional: (schema) => ({ ...schema, optional: true }),
    String: (options = {}) => ({ type: "string", ...options }),
    Number: (options = {}) => ({ type: "number", ...options }),
    Boolean: (options = {}) => ({ type: "boolean", ...options }),
    Array: (items, options = {}) => ({ type: "array", items, ...options }),
  };
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "@earendil-works/pi-ai") {
      return { StringEnum: (values) => ({ enum: values }) };
    }
    if (specifier === "typebox") return { Type };
    return {};
  };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: extensionPath });
  return module.exports.default;
}

function createHarness(entries = []) {
  let sessionEntries = entries;
  let allEntries = entries;
  let leafId = "branch-root";
  let todoSourcePath = "C:/PiDeck/resources/extensions/pi-deck-todo.ts";
  const handlers = new Map();
  const commands = new Map();
  const snapshots = [];
  const widgets = new Map();
  const notifications = [];
  let todoTool;

  const api = {
    getAllTools() {
      return [{
        name: "todo",
        sourceInfo: { path: todoSourcePath },
      }];
    },
    appendEntry(customType, data) {
      snapshots.push({ customType, data: clone(data) });
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      todoTool = tool;
    },
  };
  const extension = compileExtension();
  extension(api);

  const context = {
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setWidget(key, lines) {
        if (lines?.length) widgets.set(key, [...lines]);
        else widgets.delete(key);
      },
    },
    sessionManager: {
      getEntries() {
        return allEntries;
      },
      getBranch() {
        return sessionEntries;
      },
      getLeafId() {
        return leafId;
      },
    },
  };

  return {
    commands,
    context,
    handlers,
    notifications,
    setEntries(nextEntries) {
      sessionEntries = nextEntries;
      allEntries = nextEntries;
    },
    setAllEntries(nextEntries) {
      allEntries = nextEntries;
    },
    setLeafId(nextLeafId) {
      leafId = nextLeafId;
    },
    setTodoSourcePath(path) {
      todoSourcePath = path;
    },
    snapshots,
    widgets,
    async execute(params) {
      return todoTool.execute("todo-call", params, undefined, undefined, context);
    },
  };
}

function todoEntry(data) {
  return { type: "custom", customType: "pi-deck-todo", data };
}

async function start(harness) {
  await harness.handlers.get("session_start")({}, harness.context);
}

test("replace creates a new active plan without relying on stale completion state", async () => {
  const harness = createHarness([
    todoEntry({
      todos: [{ id: 4, text: "旧任务没有及时勾选", done: false }],
      nextId: 5,
    }),
  ]);

  await start(harness);
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:1]]",
    "☐ #4 旧任务没有及时勾选",
  ]);

  const result = await harness.execute({
    action: "replace",
    items: [{ text: "新需求的实施" }, { text: "新需求的验证" }],
  });
  const snapshot = harness.snapshots.at(-1)?.data;

  assert.equal(result.details.activePlanId, 2);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.activePlan.id, 2);
  assert.equal(snapshot.nextPlanId, 3);
  assert.equal(snapshot.nextTodoId, 7);
  assert.equal(snapshot.widgetScopeId, "branch-root");
  assert.deepEqual(snapshot.activePlan.todos, [
    { id: 5, text: "新需求的实施", done: false },
    { id: 6, text: "新需求的验证", done: false },
  ]);
  assert.deepEqual(snapshot.previousPlan, {
    id: 1,
    todos: [{ id: 4, text: "旧任务没有及时勾选", done: false }],
  });
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:branch-root:2]]",
    "☐ #5 新需求的实施",
    "☐ #6 新需求的验证",
  ]);
});

test("replace keeps todo identifiers monotonic and restore swaps the latest superseded plan back", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      activePlan: {
        id: 8,
        todos: [{ id: 19, text: "原计划", done: true }],
      },
      nextPlanId: 9,
      nextTodoId: 20,
    }),
  ]);

  await start(harness);
  await harness.execute({ action: "replace", items: [{ text: "替换后的计划" }] });
  const restored = await harness.execute({ action: "restore" });
  const snapshot = harness.snapshots.at(-1)?.data;

  assert.equal(restored.details.activePlanId, 8);
  assert.equal(snapshot.activePlan.id, 8);
  assert.equal(snapshot.nextTodoId, 21);
  assert.equal(snapshot.nextPlanId, 10);
  assert.equal(snapshot.widgetScopeId, "branch-root");
  assert.deepEqual(snapshot.activePlan.todos, [{ id: 19, text: "原计划", done: true }]);
  assert.deepEqual(snapshot.previousPlan, {
    id: 9,
    todos: [{ id: 20, text: "替换后的计划", done: false }],
  });
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:branch-root:8]]",
    "☑ #19 原计划",
  ]);
});

test("a successful branch-local mutation stamps the widget scope used for dismissal", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      widgetScopeId: "branch-a",
      activePlan: {
        id: 7,
        todos: [{ id: 11, text: "两条分支都继承的计划", done: false }],
      },
      nextPlanId: 8,
      nextTodoId: 12,
    }),
  ]);

  await start(harness);
  harness.setLeafId("branch-b");
  await harness.execute({ action: "toggle", id: 11 });
  const snapshot = harness.snapshots.at(-1)?.data;

  assert.equal(snapshot.widgetScopeId, "branch-b");
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:branch-b:7]]",
    "☑ #11 两条分支都继承的计划",
  ]);
});

test("session restoration reads the selected branch rather than all session entries", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      widgetScopeId: "branch-a",
      activePlan: { id: 1, todos: [{ id: 1, text: "选中分支", done: false }] },
      nextPlanId: 2,
      nextTodoId: 2,
    }),
  ]);
  harness.setAllEntries([
    todoEntry({
      version: 2,
      widgetScopeId: "other-branch",
      activePlan: { id: 9, todos: [{ id: 99, text: "其他分支", done: false }] },
      nextPlanId: 10,
      nextTodoId: 100,
    }),
  ]);

  await start(harness);
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:branch-a:1]]",
    "☐ #1 选中分支",
  ]);
});

test("add never infers a new plan from completion, while clear is an explicit boundary", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      activePlan: {
        id: 3,
        todos: [{ id: 8, text: "已完成的同一计划事项", done: true }],
      },
      nextPlanId: 4,
      nextTodoId: 9,
    }),
  ]);

  await start(harness);
  await harness.execute({ action: "add", text: "同一计划的后续事项" });
  let snapshot = harness.snapshots.at(-1)?.data;
  assert.equal(snapshot.activePlan.id, 3);
  assert.deepEqual(snapshot.activePlan.todos, [
    { id: 8, text: "已完成的同一计划事项", done: true },
    { id: 9, text: "同一计划的后续事项", done: false },
  ]);

  await harness.execute({ action: "clear" });
  snapshot = harness.snapshots.at(-1)?.data;
  assert.equal(snapshot.activePlan, undefined);
  assert.equal(snapshot.nextTodoId, 10);
  assert.equal(snapshot.previousPlan, undefined);
  assert.equal(harness.widgets.has("pi-deck-todo"), false);
  const clearedContext = await harness.handlers.get("context")({
    messages: [{ role: "custom", customType: "pi-deck-todo-context", content: "stale" }],
  }, harness.context);
  assert.deepEqual(clearedContext.messages, []);

  await harness.execute({ action: "add", text: "明确清空后开始的新计划" });
  snapshot = harness.snapshots.at(-1)?.data;
  assert.equal(snapshot.activePlan.id, 4);
  assert.equal(snapshot.nextPlanId, 5);
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:branch-root:4]]",
    "☐ #10 明确清空后开始的新计划",
  ]);
});

test("active plans add a non-destructive reconciliation reminder before the agent starts", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      activePlan: {
        id: 2,
        todos: [{ id: 1, text: "可能已经过时的事项", done: false }],
      },
      nextPlanId: 3,
      nextTodoId: 2,
    }),
  ]);

  await start(harness);
  const result = await harness.handlers.get("before_agent_start")({}, harness.context);

  assert.match(result.message.content, /todo replace/);
  assert.match(result.message.content, /可能已经过时的事项/);
  assert.equal(result.message.display, false);

  // Context transforms run after before_agent_start. Keep this turn's message but drop stale copies.
  const contextResult = await harness.handlers.get("context")({
    messages: [
      { role: "custom", customType: "pi-deck-todo-context", content: "stale" },
      { role: "user", content: "request" },
      { role: "custom", customType: "pi-deck-todo-context", content: result.message.content },
    ],
  }, harness.context);
  assert.equal(contextResult.messages.length, 2);
  assert.equal(contextResult.messages.at(-1).content, result.message.content);
});

test("replace rejects an empty replacement without changing the active plan", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      activePlan: {
        id: 1,
        todos: [{ id: 1, text: "保留事项", done: false }],
      },
      nextPlanId: 2,
      nextTodoId: 2,
    }),
  ]);

  await start(harness);
  const result = await harness.execute({ action: "replace", items: [] });

  assert.match(result.content[0].text, /Error/);
  assert.equal(harness.snapshots.length, 0);
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:1]]",
    "☐ #1 保留事项",
  ]);
});

test("session_tree restores the selected branch plan and third-party todo ownership clears the built-in widget", async () => {
  const harness = createHarness([
    todoEntry({
      version: 2,
      activePlan: {
        id: 1,
        todos: [{ id: 1, text: "分支 A 的计划", done: false }],
      },
      nextPlanId: 2,
      nextTodoId: 2,
    }),
  ]);

  await start(harness);
  harness.setEntries([
    todoEntry({
      version: 2,
      activePlan: {
        id: 7,
        todos: [{ id: 22, text: "分支 B 的计划", done: true }],
      },
      nextPlanId: 8,
      nextTodoId: 23,
    }),
  ]);
  await harness.handlers.get("session_tree")({}, harness.context);
  assert.deepEqual(harness.widgets.get("pi-deck-todo"), [
    "[[pid:todo-plan:7]]",
    "☑ #22 分支 B 的计划",
  ]);

  harness.setTodoSourcePath("C:/extensions/third-party-todo.ts");
  // Ownership may change after session_start but before the next session_tree event. The
  // built-in extension must not inject its plan into that third-party agent turn.
  const beforeStartResult = await harness.handlers.get("before_agent_start")({}, harness.context);
  assert.equal(beforeStartResult, undefined);
  assert.equal(harness.widgets.has("pi-deck-todo"), false);
  const contextResult = await harness.handlers.get("context")({
    messages: [{ role: "custom", customType: "pi-deck-todo-context", content: "stale" }],
  }, harness.context);
  assert.deepEqual(contextResult.messages, []);

  await harness.handlers.get("session_tree")({}, harness.context);
  assert.equal(harness.widgets.has("pi-deck-todo"), false);
  assert.equal(harness.snapshots.length, 0);
});
