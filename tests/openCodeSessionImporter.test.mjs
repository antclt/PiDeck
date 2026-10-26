import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function loadTranspiled(sourcePath, sandbox) {
	const source = readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}

function loadImporter(homePath) {
	// 统一沙箱加载器：相对 import 自动按**源文件目录**解析，不再手写 require 桥。
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath } } } });
	const mod = load("src/main/sessions/OpenCodeSessionImporter.ts");
	return { ...mod, importer: new mod.OpenCodeSessionImporter() };
}

const T0 = 1_700_000_000_000;

function seedOpenCodeDb(dbPath, projectPath) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE project (id text primary key, worktree text);
		CREATE TABLE session (id text primary key, project_id text, directory text, title text, time_created integer, time_updated integer, model text);
		CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
		CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
	`);
	db.prepare("insert into project (id, worktree) values (?, ?)").run("proj", projectPath);
	db.prepare("insert into session (id, project_id, directory, title, time_created, time_updated, model) values (?, ?, ?, ?, ?, ?, ?)").run("sess_1", "proj", projectPath, "工具栏", T0, T0 + 1000, JSON.stringify({ providerID: "opencode", modelID: "test" }));
	db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m_user", "sess_1", T0, T0, JSON.stringify({ role: "user" }));
	db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p_user", "m_user", "sess_1", T0, T0, JSON.stringify({ type: "text", text: "列一下目录" }));
	db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p_file", "m_user", "sess_1", T0, T0, JSON.stringify({ type: "file", filename: "shot.png", mime: "image/png" }));
	db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m_asst", "sess_1", T0 + 100, T0 + 200, JSON.stringify({ role: "assistant", finish: "tool-calls" }));
	db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run(
		"p_tool",
		"m_asst",
		"sess_1",
		T0 + 160,
		T0 + 180,
		JSON.stringify({
			type: "tool",
			callID: "call_abc",
			tool: "bash",
			state: { status: "completed", input: { command: "ls" }, output: "a.ts\nb.ts" },
		}),
	);
	db.close();
}

test("import: assistant 上的 tool part 拆成 toolCall + toolResult", async () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-home-"));
	try {
		const projectPath = join(home, "proj");
		const dbDir = join(home, ".local", "share", "opencode");
		mkdirSync(dbDir, { recursive: true });
		seedOpenCodeDb(join(dbDir, "opencode.db"), projectPath);

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		assert.equal(sessions.length, 1);
		const report = await importer.import(projectPath, [sessions[0].sourcePath]);
		assert.equal(report.imported, 1);

		const lines = readFileSync(report.results[0].targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		const toolCall = assistant.message.content.find((item) => item.type === "toolCall");
		assert.equal(toolCall.id, "call_abc");
		assert.equal(toolCall.name, "bash");
		assert.deepEqual(toolCall.arguments, { command: "ls" });
		assert.equal(assistant.message.stopReason, "toolUse");

		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "call_abc");
		assert.equal(toolResults[0].message.toolName, "bash");
		assert.equal(toolResults[0].message.content[0].text, "a.ts\nb.ts");

		const user = lines.find((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(user.message.content[0].text, "列一下目录");
		assert.equal(user.message.content[1].text, "[image: shot.png]");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// OpenCode 2.x 会话源：session_v2 + session_message 两表（无独立 part 表，消息按 type 列分派、
// 正文内嵌在 data JSON 里）。字段形状对照 sst/opencode packages/schema/src/session-message.ts。
function seedOpenCodeDbV2(dbPath, projectPath, { withV1Tables = false, sessions = [] } = {}) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE project (id text primary key, worktree text);
		CREATE TABLE session_v2 (id text primary key, project_id text, parent_id text, directory text, title text, model text, time_created integer, time_updated integer);
		CREATE TABLE session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
	`);
	if (withV1Tables) {
		db.exec(`
			CREATE TABLE session (id text primary key, project_id text, directory text, title text, time_created integer, time_updated integer, model text);
			CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
			CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
		`);
	}
	db.prepare("insert into project (id, worktree) values (?, ?)").run("proj", projectPath);
	const insertSession = db.prepare("insert into session_v2 (id, project_id, parent_id, directory, title, model, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)");
	const insertMessage = db.prepare("insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)");
	for (const [index, session] of sessions.entries()) {
		insertSession.run(session.id, "proj", session.parentId ?? null, projectPath, session.title, JSON.stringify(session.model ?? { id: "gpt-5", providerID: "openai" }), T0 + index, T0 + index + 1000);
		let seq = 10;
		for (const message of session.messages ?? []) {
			insertMessage.run(message.id, session.id, message.type, seq, T0 + seq, T0 + seq, JSON.stringify(message.data));
			seq += 10;
		}
	}
	if (withV1Tables) {
		db.prepare("insert into session (id, project_id, directory, title, time_created, time_updated, model) values (?, ?, ?, ?, ?, ?, ?)").run("sess_1", "proj", projectPath, "v1 老会话", T0, T0 + 500, JSON.stringify({ providerID: "legacy", modelID: "old" }));
		db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m_v1", "sess_1", T0, T0, JSON.stringify({ role: "user" }));
		db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p_v1", "m_v1", "sess_1", T0, T0, JSON.stringify({ type: "text", text: "旧会话内容" }));
	}
	db.close();
}

test("v2: session_v2 会话出现在导入列表并完整导入（#410，全新 2.x 库无 v1 表也不报错）", async () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-v2-home-"));
	try {
		const projectPath = join(home, "proj");
		const dbDir = join(home, ".local", "share", "opencode");
		mkdirSync(dbDir, { recursive: true });
		seedOpenCodeDbV2(join(dbDir, "opencode.db"), projectPath, {
			sessions: [
				{
					id: "sess_v2",
					title: "V2 会话标题",
					messages: [
						{
							id: "msg_u",
							type: "user",
							data: {
								time: { created: T0 },
								text: "帮我跑下测试",
								files: [
									{ data: "aGVsbG8=", mime: "image/png", source: { type: "inline" }, name: "shot.png" },
									{ data: "cGRm", mime: "application/pdf", source: { type: "inline" }, name: "report.pdf" },
								],
							},
						},
						{
							id: "msg_a",
							type: "assistant",
							data: {
								time: { created: T0 + 100 },
								agent: "build",
								model: { id: "gpt-5", providerID: "openai" },
								content: [
									{ type: "reasoning", text: "先想想" },
									{ type: "text", text: "好的，我来跑" },
									{ type: "tool", id: "toolu_1", name: "bash", state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "3 passed" }] } },
								],
								finish: "tool-calls",
								tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
							},
						},
						// 过程标记消息：导入时丢弃，不产生时间线条目
						{ id: "msg_m", type: "model-switched", data: { time: { created: T0 + 200 }, model: { id: "gpt-5", providerID: "openai" } } },
					],
				},
			],
		});

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].id, "sess_v2");
		assert.equal(sessions[0].title, "V2 会话标题");
		assert.equal(sessions[0].messageCount, 3);
		assert.ok(sessions[0].preview.startsWith("帮我跑下测试"));

		const report = await importer.import(projectPath, [sessions[0].sourcePath]);
		assert.equal(report.imported, 1);
		const lines = readFileSync(report.results[0].targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		const modelChange = lines.find((line) => line.type === "model_change");
		assert.equal(modelChange.provider, "openai");
		assert.equal(modelChange.modelId, "gpt-5");

		const user = lines.find((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(user.message.content[0].text, "帮我跑下测试");
		assert.deepEqual(user.message.content[1], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });
		assert.equal(user.message.content[2].text, "[attachment: report.pdf]");

		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		assert.equal(assistant.message.stopReason, "toolUse");
		assert.equal(assistant.message.provider, "openai");
		assert.equal(assistant.message.model, "gpt-5");
		assert.equal(assistant.message.content[0].thinking, "先想想");
		assert.equal(assistant.message.content[1].text, "好的，我来跑");
		assert.equal(assistant.message.content[2].type, "toolCall");
		assert.equal(assistant.message.content[2].id, "toolu_1");
		assert.equal(assistant.message.content[2].name, "bash");
		assert.deepEqual(assistant.message.content[2].arguments, { command: "npm test" });
		assert.equal(assistant.message.usage.input, 10);
		assert.equal(assistant.message.usage.output, 20);
		assert.equal(assistant.message.usage.cacheRead, 1);
		assert.equal(assistant.message.usage.cacheWrite, 2);
		assert.equal(assistant.message.usage.totalTokens, 30);

		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "toolu_1");
		assert.equal(toolResults[0].message.toolName, "bash");
		assert.equal(toolResults[0].message.content[0].text, "3 passed");

		assert.equal(lines.filter((line) => line.type === "message").length, 3);
		const sessionInfo = lines.find((line) => line.type === "session_info");
		assert.equal(sessionInfo.name, "V2 会话标题");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("v2: 子代理会话（parent_id 非空）不进导入列表", async () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-v2-child-"));
	try {
		const projectPath = join(home, "proj");
		const dbDir = join(home, ".local", "share", "opencode");
		mkdirSync(dbDir, { recursive: true });
		seedOpenCodeDbV2(join(dbDir, "opencode.db"), projectPath, {
			sessions: [
				{ id: "sess_top", title: "顶层会话", messages: [{ id: "msg_top", type: "user", data: { time: { created: T0 }, text: "顶层提问" } }] },
				{ id: "sess_child", parentId: "sess_top", title: "子代理转录", messages: [{ id: "msg_child", type: "user", data: { time: { created: T0 }, text: "子代理内部提示" } }] },
			],
		});

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		// 注意：scan 结果出自 vm 沙箱 realm，deepEqual 会因跨 realm 原型不同误报，只做标量断言
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].id, "sess_top");
		assert.equal(sessions[0].title, "顶层会话");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("v2: v1/v2 两代表并存时都列出，同 id 以 v2 为准", async () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-v2-mixed-"));
	try {
		const projectPath = join(home, "proj");
		const dbDir = join(home, ".local", "share", "opencode");
		mkdirSync(dbDir, { recursive: true });
		seedOpenCodeDbV2(join(dbDir, "opencode.db"), projectPath, {
			withV1Tables: true,
			sessions: [
				// 与 v1 表同 id：模拟 rename 迁移线的边缘情形，v2 行应胜出
				{ id: "sess_1", title: "v2 覆盖版", messages: [{ id: "msg_v2_1", type: "user", data: { time: { created: T0 }, text: "v2 正文" } }] },
				{ id: "sess_v2", title: "v2 新会话", messages: [{ id: "msg_v2_2", type: "user", data: { time: { created: T0 }, text: "新会话正文" } }] },
			],
		});

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		assert.equal(sessions.length, 2);
		assert.equal(sessions[0].id, "sess_v2");
		assert.equal(sessions[0].title, "v2 新会话");
		assert.equal(sessions[1].id, "sess_1");
		assert.equal(sessions[1].title, "v2 覆盖版");

		const report = await importer.import(
			projectPath,
			sessions.map((session) => session.sourcePath),
		);
		assert.equal(report.imported, 2);
		const sess1Lines = readFileSync(report.results.find((result) => result.id === "sess_1").targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const user = sess1Lines.find((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(user.message.content[0].text, "v2 正文");
		const sessionInfo = sess1Lines.find((line) => line.type === "session_info");
		assert.equal(sessionInfo.name, "v2 覆盖版");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("v2: assistant 工具 error 态导入为带错误文本的 toolResult", async () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-v2-err-"));
	try {
		const projectPath = join(home, "proj");
		const dbDir = join(home, ".local", "share", "opencode");
		mkdirSync(dbDir, { recursive: true });
		seedOpenCodeDbV2(join(dbDir, "opencode.db"), projectPath, {
			sessions: [
				{
					id: "sess_v2",
					title: "错误工具",
					messages: [
						{ id: "msg_u", type: "user", data: { time: { created: T0 }, text: "跑一下" } },
						{
							id: "msg_a",
							type: "assistant",
							data: {
								time: { created: T0 + 100 },
								model: { id: "gpt-5", providerID: "openai" },
								content: [{ type: "tool", id: "toolu_err", name: "bash", state: { status: "error", input: { command: "exit 1" }, error: { type: "Tool.Error", message: "命令执行失败" } } }],
								finish: "error",
							},
						},
					],
				},
			],
		});

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		const report = await importer.import(projectPath, [sessions[0].sourcePath]);
		const lines = readFileSync(report.results[0].targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "toolu_err");
		assert.equal(toolResults[0].message.isError, true);
		assert.equal(toolResults[0].message.content[0].text, "命令执行失败");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
