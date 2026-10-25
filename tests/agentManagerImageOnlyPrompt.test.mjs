import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 纯图片发送回归（Issue #404）：不再注入 "Describe this image."。
 *
 * 背景：只发截图不输入文字时，sendPrompt 曾把发给 pi 的 prompt 静默替换为固定英文
 * "Describe this image."，模型按「描述图片」回答，而用户从未输入这句话，界面上
 * 也没有任何说明。修复语义：空文本 + 图片时 message 原样（空串）发给 pi——pi 把
 * 空文本与图片一起写进用户消息，各 provider 自行丢弃空 text block（anthropic /
 * openai 兼容层均按 text 非空过滤），模型只看到图片；乐观气泡仍显示本地化占位符
 * （session.imagePlaceholder），用户界面不出现没写过的文字。
 */
const IMAGE = {
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

function createManager(requestHandler) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 30_000 }) },
		{},
		undefined,
		undefined,
		undefined,
		(key) => (key === "session.imagePlaceholder" ? "[图片]" : "Agent operation failed."),
	);
	const runtime = {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			isRunning: () => true,
			getDiagnostics: () => null,
			client: { request: requestHandler },
		},
	};
	manager.agents.set("agent-1", runtime);
	return { manager, runtime };
}

test("纯图片发送：prompt 的 message 为空串，不注入用户没写过的文案", async () => {
	const prompts = [];
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") prompts.push(payload);
		return { success: true, data: { disposition: "started" } };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "   ", images: [IMAGE] });
	assert.equal(result.accepted, true);
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].message, "", "空文本应原样发送，不得替换成 Describe this image. 之类的固定文案");
	assert.deepEqual(prompts[0].images, [IMAGE]);
});

test("纯图片发送：乐观气泡显示本地化占位符并携带图片", async () => {
	const { manager } = createManager(async () => ({ success: true, data: { disposition: "started" } }));

	await manager.sendPrompt({ agentId: "agent-1", message: "", images: [IMAGE] });
	const userMessages = (manager.messages.get("agent-1") ?? []).filter((message) => message.role === "user");
	assert.equal(userMessages.length, 1);
	assert.equal(userMessages[0].text, "[图片]");
	assert.deepEqual(userMessages[0].images, [IMAGE]);
});

test("图文混合发送：文字原样传递，行为不变", async () => {
	const prompts = [];
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") prompts.push(payload);
		return { success: true, data: { disposition: "started" } };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "这个报错是怎么回事", images: [IMAGE] });
	assert.equal(result.accepted, true);
	assert.equal(prompts[0].message, "这个报错是怎么回事");
	assert.deepEqual(prompts[0].images, [IMAGE]);
});

test("纯图片 + agentMessage 隐藏通道：隐藏载荷优先级不变", async () => {
	// 会话绑定智能体时 sessionIpc 把角色设定拼进 agentMessage；纯图片发送不能丢掉它。
	const prompts = [];
	const { manager } = createManager(async (payload) => {
		if (payload.type === "prompt") prompts.push(payload);
		return { success: true, data: { disposition: "started" } };
	});

	const result = await manager.sendPrompt({ agentId: "agent-1", message: "", images: [IMAGE], agentMessage: "角色设定" });
	assert.equal(result.accepted, true);
	assert.equal(prompts[0].message, "角色设定");
	assert.deepEqual(prompts[0].images, [IMAGE]);
});
