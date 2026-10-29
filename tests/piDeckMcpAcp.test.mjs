import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiDeckMcpService } = loadTsCommonJs("src/main/mcp/PiDeckMcpService.ts");
const { PiDeckMcpAcpSessions } = loadTsCommonJs("src/main/mcp/piDeckMcpAcpSessions.ts");
const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const projects = [
	{ id: "p1", name: "Allowed" },
	{ id: "p2", name: "Private" },
];

/** ACP 端口的最小运行环境：catalog 只建草稿，runtime 的 send/target 由每个用例改写。 */
async function harness(t, override = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-mcp-acp-"));
	const entries = new Map();
	const catalog = {
		createDraft: async (input) => {
			const record = { id: `s${entries.size + 1}`, projectId: input.projectId, title: input.title, environment: input.environment, backend: input.backend, acpToolId: input.acpToolId, status: "draft" };
			entries.set(record.id, record);
			return record;
		},
		get: (id) => entries.get(id),
	};
	const state = {
		target: undefined,
		turnActive: false,
		messages: [],
		stopResult: { ok: true, value: undefined },
	};
	const runtime = {
		send: async (input) => ({ ...input, accepted: true }),
		getTarget: () => state.target,
		getRuntimeState: async () => ({ ok: true, value: { target: state.target, value: { isTurnActive: state.turnActive } } }),
		stopRuntime: async () => state.stopResult,
	};
	const settings = createDefaultAppSettings();
	settings.acpEnabled = true;
	settings.acpTools = [
		{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], env: { GEMINI_SECRET: "s3cr3t-value" }, enabled: true },
		{ id: "retired", name: "Retired CLI", command: "retired", args: [], enabled: false },
	];
	const acp = new PiDeckMcpAcpSessions({
		catalog,
		runtime,
		readMessages: async () => [],
		settings: () => settings,
		getRuntimeMessages: () => state.messages,
		...override,
	});
	const sessions = {
		list: () => ({ sessions: [], nextOffset: null }),
		get: (_context, id) => {
			const entry = entries.get(id);
			if (!entry) throw new Error("session-not-authorized");
			return { id: entry.id, projectId: entry.projectId, title: entry.title, updatedAt: 1, createdAt: 0 };
		},
		search: () => [],
		entries: async () => ({ entries: [], nextCursor: null, version: "v", truncated: false }),
	};
	const service = new PiDeckMcpService({
		configPath: join(dir, "mcp-host.json"),
		projects: () => projects,
		sessions,
		acp,
		agents: { list: () => [], get: () => undefined, create: async () => ({}), update: async () => ({}), delete: async () => false, bindSession: async () => ({}) },
		automation: { listTasks: () => [], getTask: () => undefined, listRuns: () => [], getRun: () => undefined, createTask: async () => ({}), updateTask: async () => ({}), deleteTask: async () => false, runNow: async () => ({}), abortRun: async () => false },
		favorites: { list: () => [], get: () => undefined, add: async () => ({}), remove: async () => false },
		settings: () => settings,
		builtInExtensionsVersion: () => null,
		runtimes: () => [],
		abortRuntime: async () => ({ ok: true, value: undefined }),
		warn: () => undefined,
	});
	t.after(async () => {
		await service.dispose();
		await rm(dir, { recursive: true, force: true });
	});
	return { service, acp, settings, catalog, entries, state, runtime };
}

async function connect(t, service) {
	const definition = (await service.connection()).mcpServers.pideck;
	const client = new Client({ name: "pideck-acp-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers } });
	t.after(() => client.close());
	await client.connect(transport);
	return client;
}

async function start(t, fixture, { allowAcpInvoke = true } = {}) {
	await fixture.service.setAccess({ enabled: true, projectIds: ["p1"], allowAcpInvoke });
	return connect(t, fixture.service);
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const data = (result) => result.structuredContent.data;
const code = (result) => JSON.parse(result.content[0].text).code;

test("ACP 工具默认不注册；开关打开后才出现，且不泄露命令/参数/环境变量", async (t) => {
	const fixture = await harness(t);
	await fixture.service.setAccess({ enabled: true, projectIds: ["p1"] });
	const off = await connect(t, fixture.service);
	const names = (await off.listTools()).tools.map((tool) => tool.name);
	assert.equal(names.includes("sessions_create"), false);
	assert.equal(names.includes("acp_tools_list"), false);

	await fixture.service.setAccess({ enabled: true, projectIds: ["p1"], allowAcpInvoke: true });
	const client = await connect(t, fixture.service);
	const tools = (await client.listTools()).tools;
	const toolNames = tools.map((tool) => tool.name);
	for (const name of ["acp_tools_list", "sessions_create", "sessions_send", "sessions_wait", "sessions_messages", "sessions_stop"]) assert.equal(toolNames.includes(name), true, `缺少 ${name}`);
	assert.equal(tools.find((tool) => tool.name === "sessions_create").annotations.readOnlyHint, false);
	assert.equal(tools.find((tool) => tool.name === "sessions_wait").annotations.readOnlyHint, true);

	const listed = await call(client, "acp_tools_list");
	assert.deepEqual(data(listed), { acpEnabled: true, tools: [{ id: "gemini", name: "Gemini CLI", bypassPermissions: false }] });
	const serialized = JSON.stringify(listed);
	assert.equal(serialized.includes("s3cr3t-value"), false);
	assert.equal(serialized.includes("GEMINI_SECRET"), false);
	assert.equal(serialized.includes("--acp"), false);
});

test("ACP 总开关关闭时列表为空、建会话被拒", async (t) => {
	const fixture = await harness(t);
	fixture.settings.acpEnabled = false;
	const client = await start(t, fixture);
	assert.deepEqual(data(await call(client, "acp_tools_list")), { acpEnabled: false, tools: [] });
	const created = await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" });
	assert.equal(created.isError, true);
	assert.equal(code(created), "acp-disabled");
});

test("sessions_create 只建草稿：工具必须存在且启用，环境固定 native", async (t) => {
	const fixture = await harness(t);
	const client = await start(t, fixture);
	assert.equal(code(await call(client, "sessions_create", { projectId: "p1", acpToolId: "nope" })), "acp-tool-not-found");
	assert.equal(code(await call(client, "sessions_create", { projectId: "p1", acpToolId: "retired" })), "acp-tool-not-found");
	assert.equal(code(await call(client, "sessions_create", { projectId: "p2", acpToolId: "gemini" })), "project-not-authorized");

	const session = data(await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" }));
	assert.equal(session.backend, "acp");
	assert.equal(session.acpToolId, "gemini");
	assert.equal(session.projectId, "p1");
	assert.match(session.title, /Gemini CLI/);
	const record = fixture.entries.get(session.sessionId);
	assert.equal(record.environment, "native");
	assert.equal(record.status, "draft");
});

test("sessions_send 只接受 ACP 会话，并按项目归属校验", async (t) => {
	const fixture = await harness(t);
	fixture.entries.set("pi-1", { id: "pi-1", projectId: "p1", title: "Pi", backend: "pi", status: "active" });
	const client = await start(t, fixture);
	assert.equal(code(await call(client, "sessions_send", { projectId: "p1", sessionId: "pi-1", message: "hi" })), "session-not-acp");
	assert.equal(code(await call(client, "sessions_send", { projectId: "p1", sessionId: "s9", message: "hi" })), "session-not-authorized");
});

test("sessions_send 立即返回 accepted，sessions_wait 分段取回回答", async (t) => {
	const fixture = await harness(t);
	let finish;
	fixture.runtime.send = (input) =>
		new Promise((resolve) => {
			finish = () => resolve({ ...input, accepted: true });
		});
	const client = await start(t, fixture);
	const created = data(await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" }));
	fixture.state.target = { sessionId: created.sessionId, agentId: "acp:1", runtimeGeneration: 3 };
	fixture.state.messages = [{ id: "m1", agentId: "acp:1", role: "assistant", text: "final answer", timestamp: 1 }];

	const sent = data(await call(client, "sessions_send", { projectId: "p1", sessionId: created.sessionId, message: "hello" }));
	assert.equal(sent.status, "accepted");
	assert.equal(sent.agentId, "acp:1");
	assert.equal(sent.runtimeGeneration, 3);

	// 回合还没结束：wait 窗口用尽返回 timeout，不会误报完成。
	assert.equal(data(await call(client, "sessions_wait", { projectId: "p1", sessionId: created.sessionId, timeoutMs: 0 })).status, "timeout");
	finish();
	const waited = data(await call(client, "sessions_wait", { projectId: "p1", sessionId: created.sessionId }));
	assert.equal(waited.status, "completed");
	assert.equal(waited.reply, "final answer");
});

test("回合在短窗口内结束则 send 直接返回 completed；忙时返回 session-busy", async (t) => {
	const fixture = await harness(t);
	const client = await start(t, fixture);
	const created = data(await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" }));
	fixture.state.target = { sessionId: created.sessionId, agentId: "acp:1", runtimeGeneration: 1 };
	fixture.state.messages = [{ id: "m1", agentId: "acp:1", role: "assistant", text: "short answer", timestamp: 1 }];
	const done = data(await call(client, "sessions_send", { projectId: "p1", sessionId: created.sessionId, message: "hi" }));
	assert.equal(done.status, "completed");
	assert.equal(done.reply, "short answer");

	fixture.runtime.send = async (input) => ({ ...input, accepted: false, error: "ACP agent is still responding", delivery: "rejected", i18nKey: "acp.turnBusy" });
	const busy = data(await call(client, "sessions_send", { projectId: "p1", sessionId: created.sessionId, message: "again" }));
	assert.equal(busy.status, "failed");
	assert.equal(busy.error, "session-busy");
});

test("sessions_messages 只返回有界文本投影，不包含图片载荷", async (t) => {
	const fixture = await harness(t, {
		readMessages: async () => [
			{ id: "m1", agentId: "acp:1", role: "user", text: "question", timestamp: 1, images: [{ type: "image", data: "secret-image", mimeType: "image/png" }] },
			{ id: "m2", agentId: "acp:1", role: "assistant", text: "answer", timestamp: 2 },
		],
	});
	const client = await start(t, fixture);
	const created = data(await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" }));
	fixture.entries.get(created.sessionId).acpSessionId = "agent-session-1";
	const page = await call(client, "sessions_messages", { projectId: "p1", sessionId: created.sessionId });
	assert.deepEqual(data(page).messages, [
		{ id: "m1", role: "user", text: "question", timestamp: 1 },
		{ id: "m2", role: "assistant", text: "answer", timestamp: 2 },
	]);
	assert.equal(JSON.stringify(page).includes("secret-image"), false);

	// 草稿还没握手：空页而不是报错。
	const draft = data(await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" }));
	assert.deepEqual(data(await call(client, "sessions_messages", { projectId: "p1", sessionId: draft.sessionId })), { messages: [], total: 0, nextBefore: null });
});

test("sessions_stop 校验代次并释放运行时；没在跑时报 session-not-running", async (t) => {
	const fixture = await harness(t);
	const client = await start(t, fixture);
	const created = data(await call(client, "sessions_create", { projectId: "p1", acpToolId: "gemini" }));
	assert.equal(code(await call(client, "sessions_stop", { projectId: "p1", sessionId: created.sessionId })), "session-not-running");

	fixture.state.target = { sessionId: created.sessionId, agentId: "acp:1", runtimeGeneration: 2 };
	assert.equal(code(await call(client, "sessions_stop", { projectId: "p1", sessionId: created.sessionId, expectedRuntimeGeneration: 1 })), "runtime-changed");
	assert.deepEqual(data(await call(client, "sessions_stop", { projectId: "p1", sessionId: created.sessionId, expectedRuntimeGeneration: 2 })), { sessionId: created.sessionId, stopped: true });
});
