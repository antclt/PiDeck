import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// CuaIpcManager imports from electron (ipcMain, BrowserWindow) which is not
// available in the test VM. We stub electron before loading.
const electronStub = {
  ipcMain: {
    handle: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {},
};

const { CuaIpcManager } = loadTsCommonJs("src/main/ipc/cuaIpc.ts", {
  stubs: {
    electron: electronStub,
  },
  globals: {
    fetch: globalThis.fetch.bind(globalThis),
  },
});

function makeFakeGate() {
  return {
    isEnabled: () => true,
    setEnabled: () => {},
    setSessionOverride: () => {},
    // Exposed for CuaIpcManager internal access to config.sessionOverrides
    config: { sessionOverrides: new Map() },
  };
}

function makeFakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: () => {} },
  };
}

test("CuaIpcManager creates approval handler that resolves", async () => {
  let sentPayload = null;
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, payload) => {
        sentPayload = payload;
      },
    },
  };

  const manager = new CuaIpcManager({
    gate: makeFakeGate(),
    mainWindow: () => fakeWindow,
    log: () => {},
  });

  const handler = manager.createApprovalHandler();

  const approvalPromise = handler({
    action: "click",
    sessionId: "test-session",
    detail: { x: 100, y: 200 },
    timestampMs: Date.now(),
  });

  // Wait for the payload to be sent to renderer.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(sentPayload, "payload should have been sent to renderer");
  assert.strictEqual(sentPayload.action, "click");
  assert.ok(sentPayload.requestId, "requestId should be present");

  // Manually resolve the pending approval (simulating renderer response).
  const pending = manager.pendingApprovals.get(sentPayload.requestId);
  assert.ok(pending, "pending approval should exist");

  pending.resolve({ allowed: true });

  const result = await approvalPromise;
  assert.strictEqual(result.allowed, true);

  manager.dispose();
});

test("CuaIpcManager handles no window scenario", async () => {
  const manager = new CuaIpcManager({
    gate: makeFakeGate(),
    mainWindow: () => null,
    log: () => {},
  });

  const handler = manager.createApprovalHandler();
  const result = await handler({
    action: "click",
    sessionId: "test-session",
    detail: {},
    timestampMs: Date.now(),
  });

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, "no_window");
});

test("CuaIpcManager dispose resolves pending approvals", async () => {
  const fakeWindow = makeFakeWindow();

  const manager = new CuaIpcManager({
    gate: makeFakeGate(),
    mainWindow: () => fakeWindow,
    log: () => {},
  });

  const handler = manager.createApprovalHandler();
  const approvalPromise = handler({
    action: "type",
    sessionId: "test-session",
    detail: { text: "hello" },
    timestampMs: Date.now(),
  });

  await new Promise((resolve) => setTimeout(resolve, 50));

  manager.dispose();

  const result = await approvalPromise;
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, "disposed");
});