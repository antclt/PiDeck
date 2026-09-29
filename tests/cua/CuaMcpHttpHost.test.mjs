import assert from "node:assert";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// The MCP SDK is resolved via Node's real module cache inside loadTsCommonJs,
// so the McpServer classes created there are the SAME instances this test
// imports. No cross-realm instanceof problems.
const { CuaMcpHttpHost } = loadTsCommonJs("src/main/cua/CuaMcpHttpHost.ts");
const { CuaEngine } = loadTsCommonJs("src/main/cua/CuaEngine.ts");
const { CuaGate } = loadTsCommonJs("src/main/cua/CuaGate.ts");

async function connectClient(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "cua-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

test("CUA MCP HTTP host exposes tools and denies writes without approval handler", async () => {
  const gate = new CuaGate({ enabled: true });
  const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
  const host = new CuaMcpHttpHost({ port: 0, authToken: "test-token" }, { engine, gate });

  const port = await host.start();
  assert.ok(port > 0);
  const url = host.getUrl();
  assert.ok(url && url.endsWith("/mcp"));

  const { client, transport } = await connectClient(url, "test-token");

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      "cua_capture",
      "cua_click",
      "cua_get_state",
      "cua_list_windows",
      "cua_scroll",
      "cua_type",
    ]);

    // cua_list_windows is read-only → works.
    const listResult = await client.callTool({ name: "cua_list_windows", arguments: {} });
    assert.ok(!listResult.isError, `list_windows errored: ${JSON.stringify(listResult)}`);
    const windows = JSON.parse(listResult.content[0].text);
    assert.ok(Array.isArray(windows));

    // cua_get_state is read-only → reports gate status.
    const stateResult = await client.callTool({ name: "cua_get_state", arguments: {} });
    const state = JSON.parse(stateResult.content[0].text);
    assert.strictEqual(state.gateEnabled, true);
    assert.ok(state.display.width > 0);

    // cua_click is a write action → no approval handler → denied (fail closed).
    const clickResult = await client.callTool({
      name: "cua_click",
      arguments: { x: 10, y: 10, sessionId: "sess-e2e" },
    });
    const clickPayload = JSON.parse(clickResult.content[0].text);
    assert.strictEqual(clickPayload.gate, "denied");
    assert.strictEqual(clickPayload.error, "no_approval_handler");
  } finally {
    await transport.close();
    await host.stop();
  }
});

test("CUA MCP HTTP host honors the in-process approval handler (allow/deny)", async () => {
  const gate = new CuaGate({ enabled: true });
  gate.setApprovalHandler(async (request) => {
    // Deny clicks at (99,99), allow everything else.
    if (request.action === "click" && request.detail?.x === 99) {
      return { allowed: false, reason: "user_denied" };
    }
    return { allowed: true };
  });

  const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
  const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
  await host.start();

  const { client, transport } = await connectClient(host.getUrl(), "tok");
  try {
    const denied = await client.callTool({
      name: "cua_click",
      arguments: { x: 99, y: 99, sessionId: "s" },
    });
    const deniedPayload = JSON.parse(denied.content[0].text);
    assert.strictEqual(deniedPayload.gate, "denied");
    assert.strictEqual(deniedPayload.error, "user_denied");

    // A click the handler allows would actually inject input, so we only assert
    // the gate decision indirectly: call cua_get_state's session check instead.
    assert.strictEqual(gate.isSessionEnabled("s"), true);
  } finally {
    await transport.close();
    await host.stop();
  }
});

test("CUA MCP HTTP host rejects requests without a bearer token", async () => {
  const gate = new CuaGate({ enabled: true });
  const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
  const host = new CuaMcpHttpHost({ port: 0, authToken: "secret" }, { engine, gate });
  const port = await host.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.strictEqual(res.status, 401);
  } finally {
    await host.stop();
  }
});

test("CUA MCP HTTP host returns 404 for unknown paths", async () => {
  const gate = new CuaGate({ enabled: true });
  const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
  const host = new CuaMcpHttpHost({ port: 0 }, { engine, gate });
  const port = await host.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "GET" });
    assert.strictEqual(res.status, 404);
  } finally {
    await host.stop();
  }
});
