/**
 * 空白回合诊断串（debugDetails）与响应片段提取的单测：
 * 概括文案「没有返回任何输出」区分不出限流/登录失败/事件流丢失，原始证据必须能
 * 拼进 toast（渲染层截前 140 字符）与主进程日志。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { describeEmptyTurn, emptyTurnRejection, promptResultSnippet } = loadTsCommonJs("src/main/acp/acpTurnSettlement.ts");

test("describeEmptyTurn 把 stderr 排在最前,并带上 stopReason/update 统计/通知/响应原文", () => {
	const details = describeEmptyTurn({
		stopReason: "end_turn",
		updateKinds: new Map([["agent_message_chunk", 3]]),
		stderrTail: ["line1", "Error: quota exceeded"],
		foreignNotification: 'session/error: {"message":"quota"}',
		rawResult: '{"error":"quota"}',
	});
	assert.match(details, /^stderr=line1 \| Error: quota exceeded;/);
	assert.match(details, /stopReason=end_turn/);
	assert.match(details, /updates=agent_message_chunkx3/);
	assert.match(details, /notification=session\/error/);
	assert.match(details, /result=\{"error":"quota"\}$/);
});

test("describeEmptyTurn 无 update 时写 none", () => {
	assert.equal(describeEmptyTurn({ stopReason: "end_turn" }), "stopReason=end_turn; updates=none");
});

test("promptResultSnippet 只保留 stopReason/_meta 之外的字段", () => {
	assert.equal(promptResultSnippet({ stopReason: "end_turn", _meta: { a: 1 } }), undefined);
	assert.equal(promptResultSnippet({ stopReason: "end_turn", error: "quota" }), '{"error":"quota"}');
	assert.equal(promptResultSnippet(undefined), undefined);
});

test("emptyTurnRejection 带上诊断,无诊断时保持原样", () => {
	assert.equal(emptyTurnRejection("CodeBuddy").debugDetails, undefined);
	assert.equal(emptyTurnRejection("CodeBuddy", "stderr=boom").debugDetails, "stderr=boom");
});
