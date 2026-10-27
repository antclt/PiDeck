import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";

/**
 * 会话引用（`&会话名` → `<referenced_session>`）的上下文口径。
 *
 * 现场（2026-11）：引用一个大对话后上游上下文涨到 600K token。根因两条，本文件各钉一组：
 * 1) 取文复用了标题推断的 `extractTextFromContent`（`record.text ?? record.thinking`），
 *    把思考链当正文塞进引用（实测占引用正文 84%）；
 * 2) 拼接没有任何预算，1000 条 / 8MB 的 IPC 上限 ≈ 200 万 token，不构成上下文护栏。
 */

function contextModule() {
	return loadTsCommonJs("src/shared/sessionReferenceContext.ts");
}

test("thinking 块不进引用正文（回归：思考链被当成正文）", () => {
	const { extractReferenceMessageText } = contextModule();
	const content = [
		{ type: "thinking", thinking: "THINKING-CHAIN-SHOULD-NOT-APPEAR" },
		{ type: "text", text: "这是最终回答" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
	];
	const text = extractReferenceMessageText(content);
	assert.ok(text.includes("这是最终回答"));
	assert.ok(!text.includes("THINKING-CHAIN-SHOULD-NOT-APPEAR"), "thinking 不得进入引用正文");
});

test("图片与工具结果块同样不入选，字符串 content 原样返回", () => {
	const { extractReferenceMessageText } = contextModule();
	const image = extractReferenceMessageText([{ type: "image", data: "AAA", mimeType: "image/png" }, { type: "text", text: "看图" }]);
	assert.equal(image, "看图");
	assert.equal(extractReferenceMessageText("纯文本消息"), "纯文本消息");
	assert.equal(extractReferenceMessageText(null), "");
});

test("预算内：全部保留、无截断、按 [User]/[Assistant] 逐行", () => {
	const { buildSessionReferenceContext } = contextModule();
	const result = buildSessionReferenceContext([
		{ role: "user", content: "问题一" },
		{ role: "assistant", content: "回答一" },
	]);
	assert.equal(result.dropped, 0);
	assert.equal(result.kept, 2);
	assert.equal(result.body, "[User]: 问题一\n[Assistant]: 回答一");
});

test("超预算：保留最近的消息，更早的被裁掉并回报条数", () => {
	const { buildSessionReferenceContext } = contextModule();
	const messages = [
		{ role: "user", content: `OLDEST-${"甲".repeat(400)}` },
		{ role: "assistant", content: `MIDDLE-${"乙".repeat(400)}` },
		{ role: "user", content: `NEWEST-${"丙".repeat(400)}` },
	];
	const result = buildSessionReferenceContext(messages, { tokenBudget: 800 });
	assert.ok(result.dropped > 0, "超预算必须裁掉更早的消息");
	assert.ok(result.kept >= 1);
	assert.ok(result.body.includes("NEWEST-"), "最新一条必须保留");
	assert.ok(!result.body.includes("OLDEST-"), "最早一条应被裁掉");
	assert.equal(result.kept + result.dropped, messages.length);
});

test("单条消息自己就超预算：被截断且不超过预算", () => {
	const { buildSessionReferenceContext, estimateReferenceTokens } = contextModule();
	const result = buildSessionReferenceContext([{ role: "assistant", content: "丁".repeat(5000) }], { tokenBudget: 500 });
	assert.equal(result.kept, 1);
	assert.ok(result.body.endsWith("…"), "截断处应有省略号");
	assert.ok(estimateReferenceTokens(result.body) <= 510, `截断后仍在预算内，实际 ${result.tokens}`);
});

test("空列表不产生空块正文", () => {
	const { buildSessionReferenceContext } = contextModule();
	const result = buildSessionReferenceContext([]);
	assert.equal(result.body, "");
	assert.equal(result.kept, 0);
	assert.equal(result.dropped, 0);
	assert.equal(result.tokens, 0);
});

test("readMessages 端到端：JSONL 里的 thinking 不进消息正文", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-ref-context-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const sessionPath = join(home, "session-1.jsonl");
		const lines = [
			{ type: "session", version: 3 },
			{ type: "message", timestamp: 1, message: { role: "user", content: "用户提问" } },
			{
				type: "message",
				timestamp: 2,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "SECRET-THINKING" },
						{ type: "text", text: "助手回答" },
						{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
					],
				},
			},
			{ type: "message", timestamp: 3, message: { role: "toolResult", toolCallId: "t1", content: "TOOL-OUTPUT" } },
		];
		writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n"));

		const messages = await new SessionScanner().readMessages(sessionPath);
		// 跨 vm 加载：sandbox 里的数组/对象原型与宿主不同，比较前先摊成宿主值。
		assert.deepEqual(
			[...messages.map((message) => String(message.role))],
			["user", "assistant"],
			"只回传 user/assistant（toolResult 不入引用）",
		);
		assert.ok(!messages.some((message) => String(message.content).includes("SECRET-THINKING")), "thinking 不得出现在引用消息里");
		assert.ok(String(messages[1]?.content).includes("助手回答"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
