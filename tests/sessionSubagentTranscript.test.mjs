/**
 * 子代理会话读取链路行为测试（2026-10「点进子代理会话一半没渲染」修复）：
 * - main：projectDshSubagentTranscriptPage —— DSH transcript 页投影
 *   事件按 seq 升序投影、oldestSeq 游标、hasMore 透传、空页/无 seq 兜底
 * - renderer：mergeOlderDshTranscriptPage —— 「加载更早」整页前置、按消息 id 去重、空页收口
 * - renderer：readSessionFirstScreenPage —— 子代理子会话首开数据页沿游标补页到预算；
 *   普通会话单页即返；unavailable 透传给时间线专态闸门；游标不前进防死循环
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const main = loadTsCommonJs("src/main/dsh/dshSubagentTranscript.ts", {});

const renderer = loadTsCommonJs("src/renderer/src/components/session/sessionSubagentTranscript.ts", {
	stubs: {
		"./composer/quoteChip": { replaceExpandedRefBlocksWithLabels: (text) => text },
	},
});

function userEvent(seq, text) {
	return { event: { type: "user/message", seq, data: { content: [{ type: "text", text }] } }, view: undefined };
}

function chatMessage(overrides) {
	return { id: "m1", agentId: "dsh:child", role: "assistant", text: "hello", timestamp: 1700000000000, ...overrides };
}

/** 构造 count 轮（user + assistant 成对）的消息序列，id 从 startIndex 起编号。 */
function turns(count, startIndex) {
	const messages = [];
	for (let index = 0; index < count; index += 1) {
		messages.push(chatMessage({ id: `u${startIndex + index}`, role: "user", text: `q${startIndex + index}` }));
		messages.push(chatMessage({ id: `a${startIndex + index}`, role: "assistant", text: `ans${startIndex + index}` }));
	}
	return messages;
}

function page(overrides) {
	return { messages: [], total: 0, nextBefore: null, ...overrides };
}

function scriptedReader(pages) {
	const calls = [];
	const readPage = async (sessionId, before, pageSize) => {
		calls.push({ sessionId, before, pageSize });
		const next = pages.shift();
		if (!next) throw new Error("unexpected extra page read");
		return next;
	};
	return { readPage, calls };
}

test("main: transcript page sorts events by seq and exposes the oldest seq cursor", () => {
	const result = main.projectDshSubagentTranscriptPage([userEvent(3, "second"), userEvent(1, "first"), userEvent(2, "middle")], "dsh:child", true);
	assert.equal(result.messages.length, 3);
	// 沙箱模块返回的数组/对象来自另一个 vm realm，先拷回测试 realm 再 deepEqual
	assert.deepEqual(
		[...result.messages].map((message) => message.text),
		["first", "middle", "second"],
	);
	assert.deepEqual(
		[...result.messages].map((message) => message.id),
		["dsh:1", "dsh:2", "dsh:3"],
	);
	assert.equal(result.oldestSeq, 1);
	assert.equal(result.hasMore, true);
});

test("main: empty event list yields an empty page without a cursor", () => {
	const result = main.projectDshSubagentTranscriptPage([], "dsh:child", false);
	assert.deepEqual([...result.messages], []);
	assert.equal(result.hasMore, false);
	assert.equal(result.oldestSeq, undefined);
});

test("main: events without a numeric seq still project and omit the cursor", () => {
	const result = main.projectDshSubagentTranscriptPage([{ event: { type: "user/message", data: { content: [{ type: "text", text: "legacy" }] } }, view: undefined }], "dsh:child", true);
	assert.equal(result.messages.length, 1);
	assert.equal(result.oldestSeq, undefined);
});

test("renderer: transcript row mapping keeps id/role and routes text through quoteChip", () => {
	const row = renderer.dshTranscriptRowFromMessage(chatMessage({ id: "m9", role: "user", text: "raw" }));
	assert.deepEqual({ ...row }, { id: "m9", role: "user", text: "raw" });
});

test("renderer: load-older merge prepends older rows and dedupes boundary messages by id", () => {
	const existing = [renderer.dshTranscriptRowFromMessage(chatMessage({ id: "dsh:5", role: "user", text: "five" }))];
	const merged = renderer.mergeOlderDshTranscriptPage(existing, {
		messages: [chatMessage({ id: "dsh:4", role: "assistant", text: "four" }), chatMessage({ id: "dsh:5", role: "user", text: "five-dup" })],
		hasMore: true,
		oldestSeq: 3,
	});
	assert.deepEqual(
		[...merged.rows].map((row) => row.id),
		["dsh:4", "dsh:5"],
	);
	assert.equal(merged.rows[0].text, "four");
	assert.equal(merged.rows[1].text, "five", "重复 id 的边界消息不得覆盖已有行");
	assert.equal(merged.hasMore, true);
	assert.equal(merged.oldestSeq, 3);
});

test("renderer: empty older page collapses hasMore so the load-older button stops", () => {
	const merged = renderer.mergeOlderDshTranscriptPage([], { messages: [], hasMore: true, oldestSeq: 9 });
	assert.deepEqual([...merged.rows], []);
	assert.equal(merged.hasMore, false);
});

test("renderer: plain sessions read exactly one disk page", async () => {
	const { readPage, calls } = scriptedReader([page({ messages: turns(9, 0), total: 18, nextBefore: null })]);
	const result = await renderer.readSessionFirstScreenPage(readPage, "s1", undefined);
	assert.equal(calls.length, 1);
	assert.equal(result.messages.length, 18);
	assert.deepEqual(calls[0], { sessionId: "s1", before: undefined, pageSize: renderer.DISK_INITIAL_TURN_PAGE_SIZE });
});

test("renderer: child sessions backfill pages along nextBefore until the turn budget", async () => {
	const { readPage, calls } = scriptedReader([
		page({ messages: turns(9, 36), total: 90, nextBefore: 36, model: { provider: "p", modelId: "m" }, thinkingLevel: "high", indexVersion: "v1" }),
		page({ messages: turns(9, 27), total: 90, nextBefore: 27 }),
		page({ messages: turns(9, 18), total: 90, nextBefore: 18 }),
		page({ messages: turns(9, 9), total: 90, nextBefore: 9 }),
		page({ messages: turns(9, 0), total: 90, nextBefore: 0 }),
	]);
	const result = await renderer.readSessionFirstScreenPage(readPage, "s1", "parent/session.jsonl");
	// 首页 9 轮 + 4 页补拉 = 45 轮 ≥ 40 预算即停，即使末页仍带 nextBefore
	assert.equal(calls.length, 5);
	assert.deepEqual(
		calls.map((call) => call.before),
		[undefined, 36, 27, 18, 9],
	);
	assert.ok(calls.every((call) => call.pageSize === renderer.DISK_INITIAL_TURN_PAGE_SIZE));
	// 旧页整段前置：消息顺序从最老到最新
	assert.equal(result.messages.length, 90);
	assert.equal(result.messages[0].id, "u0");
	assert.equal(result.messages.at(-1).id, "a44");
	// 游标指向最老一页；元数据保留首读（最新切片）的值
	assert.equal(result.nextBefore, 0);
	assert.equal(result.total, 90);
	assert.deepEqual({ ...result.model }, { provider: "p", modelId: "m" });
	assert.equal(result.thinkingLevel, "high");
	assert.equal(result.indexVersion, "v1");
});

test("renderer: child sessions stop backfilling when the host reports the top", async () => {
	const { readPage, calls } = scriptedReader([page({ messages: turns(2, 2), total: 8, nextBefore: 4 }), page({ messages: turns(2, 0), total: 8, nextBefore: null })]);
	const result = await renderer.readSessionFirstScreenPage(readPage, "s1", "parent.jsonl");
	assert.equal(calls.length, 2);
	assert.equal(result.nextBefore, null);
	assert.equal(result.messages.length, 8);
});

test("renderer: unavailable first page is returned untouched for the timeline gate", async () => {
	const { readPage, calls } = scriptedReader([page({ unavailable: "dsh-host-stopped" })]);
	const result = await renderer.readSessionFirstScreenPage(readPage, "s1", "parent.jsonl");
	assert.equal(calls.length, 1);
	assert.equal(result.unavailable, "dsh-host-stopped");
});

test("renderer: a follow-up page turning unavailable wins over the merged prefix", async () => {
	const { readPage, calls } = scriptedReader([page({ messages: turns(9, 9), total: 18, nextBefore: 9 }), page({ unavailable: "dsh-host-stopped" })]);
	const result = await renderer.readSessionFirstScreenPage(readPage, "s1", "parent.jsonl");
	assert.equal(calls.length, 2);
	assert.equal(result.unavailable, "dsh-host-stopped");
	assert.equal(result.messages.length, 0);
});

test("renderer: a non-advancing cursor stops backfilling instead of looping forever", async () => {
	const { readPage, calls } = scriptedReader([page({ messages: turns(9, 9), total: 18, nextBefore: 5 }), page({ messages: turns(9, 0), total: 18, nextBefore: 5 })]);
	const result = await renderer.readSessionFirstScreenPage(readPage, "s1", "parent.jsonl");
	assert.equal(calls.length, 2);
	// 收口返回已合并内容，游标保持原值留给下一次正常翻页
	assert.equal(result.nextBefore, 5);
	assert.equal(result.messages.length, 18);
});
