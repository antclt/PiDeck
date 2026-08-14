import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { CompositeAgentGateway } = loadTsCommonJs("src/main/agents/CompositeAgentGateway.ts");

/** 构造一个最小假网关：backend 身份 + 能力集 + 一个可创建/停止 agent 的内存注册表。 */
function makeFakeGateway(backend, capabilities = [], seedTabs = []) {
	const tabs = new Map(seedTabs.map((tab) => [tab.id, tab]));
	const calls = { create: 0, stop: 0, restarts: 0 };
	const listeners = [];
	const outputs = [];
	const gateway = {
		backend,
		capabilities: new Set(capabilities),
		list() {
			return [...tabs.values()];
		},
		async create(input) {
			calls.create += 1;
			const tab = {
				id: `agent-${backend}-${calls.create}`,
				projectId: input.projectId,
				cwd: ".",
				title: input.title ?? backend,
				status: "idle",
				backend,
				createdAt: 0,
			};
			tabs.set(tab.id, tab);
			return tab;
		},
		async restart(agentId) {
			calls.restarts += 1;
			// 模拟重启后换新 id 的网关
			const old = tabs.get(agentId);
			tabs.delete(agentId);
			const tab = { ...old, id: `${old.id}-restarted`, status: "idle" };
			tabs.set(tab.id, tab);
			return tab;
		},
		async stop(agentId) {
			calls.stop += 1;
			tabs.delete(agentId);
		},
		async getRuntimeState() {
			return {};
		},
		async abort() {},
		async compact() {
			return {};
		},
		async rename() {
			return {};
		},
		async getCommands() {
			return [];
		},
		async getAvailableModels() {
			return [];
		},
		async exportHtml() {},
		async editMessage() {},
		async deleteMessage() {},
		async prepareResendFromMessage() {
			return { text: "" };
		},
		async setModel() {},
		async setThinking() {},
		async publishRuntimeState() {},
		async getForkMessages() {
			return [];
		},
		async forkSession() {},
		async sendUIResponse() {},
		getMessages() {
			return [];
		},
		notifyAskPending() {
			listeners.push({ kind: "ask" });
		},
		onOutput(listener) {
			outputs.push(listener);
			return () => {
				const at = outputs.indexOf(listener);
				if (at >= 0) outputs.splice(at, 1);
			};
		},
	};
	return { gateway, calls, tabs, listeners, outputs };
}

test("list 合并所有后端网关的 agent", () => {
	const pi = makeFakeGateway("pi", [], [
		{ id: "a1", projectId: "p", cwd: ".", title: "t", status: "idle", backend: "pi", createdAt: 0 },
	]);
	const dsh = makeFakeGateway("dsh", [], [
		{ id: "a2", projectId: "p", cwd: ".", title: "t", status: "idle", backend: "dsh", createdAt: 0 },
	]);
	const composite = new CompositeAgentGateway([pi.gateway, dsh.gateway]);
	assert.deepEqual(composite.list().map((tab) => tab.id), ["a1", "a2"]);
});

test("create 按 input.backend 路由，缺省走默认后端（pi，兼容旧调用方）", async () => {
	const pi = makeFakeGateway("pi");
	const dsh = makeFakeGateway("dsh");
	const composite = new CompositeAgentGateway([pi.gateway, dsh.gateway]);

	const explicit = await composite.create({ projectId: "p", backend: "dsh" });
	assert.equal(explicit.id, "agent-dsh-1");
	assert.equal(dsh.calls.create, 1);
	assert.equal(pi.calls.create, 0);

	const legacy = await composite.create({ projectId: "p" });
	assert.equal(legacy.id, "agent-pi-1");
	assert.equal(pi.calls.create, 1);
});

test("create 到未注册的 backend 抛错", async () => {
	const pi = makeFakeGateway("pi");
	const composite = new CompositeAgentGateway([pi.gateway]);
	await assert.rejects(
		composite.create({ projectId: "p", backend: "dsh" }),
		/no gateway for backend "dsh"/,
	);
});

test("per-agent 命令路由到持有该 agent 的网关（create 建立归属）", async () => {
	const pi = makeFakeGateway("pi");
	const dsh = makeFakeGateway("dsh");
	const composite = new CompositeAgentGateway([pi.gateway, dsh.gateway]);

	const dshTab = await composite.create({ projectId: "p", backend: "dsh" });
	const piTab = await composite.create({ projectId: "p", backend: "pi" });

	await composite.stop(dshTab.id);
	assert.equal(dsh.calls.stop, 1);
	assert.equal(pi.calls.stop, 0);
	assert.equal(dsh.tabs.size, 0);

	await composite.stop(piTab.id);
	assert.equal(pi.calls.stop, 1);
	assert.equal(pi.tabs.size, 0);
});

test("owner 通过 list() 兜底查找（未经过 create 的存量 agent）", async () => {
	const pi = makeFakeGateway("pi", [], [
		{ id: "legacy-agent", projectId: "p", cwd: ".", title: "t", status: "idle", backend: "pi", createdAt: 0 },
	]);
	const composite = new CompositeAgentGateway([pi.gateway]);
	await composite.stop("legacy-agent");
	assert.equal(pi.calls.stop, 1);
});

test("未知 agent 抛错（上游 Coordinator 转 SESSION_COMMAND_FAILED）", async () => {
	const pi = makeFakeGateway("pi");
	const composite = new CompositeAgentGateway([pi.gateway]);
	await assert.rejects(composite.stop("ghost"), /no gateway owns agent "ghost"/);
});

test("restart 后新 id 更新归属", async () => {
	const dsh = makeFakeGateway("dsh", [], [
		{ id: "old-id", projectId: "p", cwd: ".", title: "t", status: "idle", backend: "dsh", createdAt: 0 },
	]);
	const composite = new CompositeAgentGateway([dsh.gateway]);
	const restarted = await composite.restart("old-id");
	assert.equal(restarted.id, "old-id-restarted");
	// 新 id 的命令仍路由到 dsh 网关
	await composite.stop(restarted.id);
	assert.equal(dsh.calls.stop, 1);
});

test("capabilities 取所有子网关并集", () => {
	const pi = makeFakeGateway("pi", ["compact", "fork"]);
	const dsh = makeFakeGateway("dsh", ["fork"]);
	const composite = new CompositeAgentGateway([pi.gateway, dsh.gateway]);
	assert.deepEqual([...composite.capabilities].sort(), ["compact", "fork"]);
});

test("onOutput 聚合所有子网关并支持统一退订", () => {
	const pi = makeFakeGateway("pi");
	const dsh = makeFakeGateway("dsh");
	const composite = new CompositeAgentGateway([pi.gateway, dsh.gateway]);
	const seen = [];
	const unsubscribe = composite.onOutput((channel, payload) => seen.push([channel, payload]));

	pi.outputs[pi.outputs.length - 1]("agents:state", { n: 1 });
	dsh.outputs[dsh.outputs.length - 1]("agents:state", { n: 2 });
	assert.equal(seen.length, 2);

	unsubscribe();
	assert.equal(pi.outputs.length, 0, "退订后子网关监听器被移除");
	assert.equal(dsh.outputs.length, 0, "退订后子网关监听器被移除");
});

test("notifyAskPending 路由到持有该 agent 的网关", () => {
	const pi = makeFakeGateway("pi", [], [
		{ id: "a1", projectId: "p", cwd: ".", title: "t", status: "idle", backend: "pi", createdAt: 0 },
	]);
	const composite = new CompositeAgentGateway([pi.gateway]);
	composite.notifyAskPending("a1", "s1", "t", "q");
	assert.equal(pi.listeners.length, 1);
});
