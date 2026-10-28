import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 飞书桥忙时排队契约（issue #427：重入策略从「丢弃」改成「排队」）。
 *
 * 旧实现：`processingChats.has(chatId)` 命中就只写一行日志然后 return——用户在群里
 * 完全没反馈，消息也不会补跑；5s 同文本去重还会吞掉用户主动连发的两句「在吗」。
 * 新契约：忙时按 chatId 排队并回执「第 N 位」，上一轮收尾后自动重放；
 * 幂等只认 event_id / message_id（平台重投），不再按文本内容去重。
 * 正则按 AGENTS.md 惯例做空白容忍。
 */

const bridge = readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");
const i18n = readFileSync("src/main/feishu/FeishuI18n.ts", "utf8");

test("busy re-entry enqueues the raw event instead of dropping it", () => {
	const busyBlock = bridge.match(/if\s*\(\s*this\.processingChats\.has\(chatId\)\s*\)\s*\{[\s\S]*?\n\t\t\}/);
	assert.ok(busyBlock, "忙时分支应存在");
	assert.match(busyBlock[0], /this\.enqueuePendingMessage\(\s*chatId,\s*data\s*\)/, "忙时必须入队并回执");
	assert.doesNotMatch(busyBlock[0], /跳过重入消息/, "不得再静默丢弃重入消息");
});

test("the pending queue is drained after a run settles and re-dispatches the queued event", () => {
	const finallyBlock = bridge.match(/finally\s*\{\s*this\.processingChats\.delete\(chatId\);\s*this\.drainPendingMessageQueue\(chatId\);\s*\}/);
	assert.ok(finallyBlock, "run 收尾必须 drain 队列");

	const drain = bridge.match(/private drainPendingMessageQueue\(chatId: string\): void \{[\s\S]*?\n\t\}/);
	assert.ok(drain, "drain 实现应存在");
	// 重放前必须撤销幂等记录，否则 handleMessage 会把这条消息当成平台重投直接丢掉。
	assert.match(drain[0], /recentEventIds\.delete\(eventId\)/);
	assert.match(drain[0], /recentMessageIds\.delete\(messageId\)/);
	assert.match(drain[0], /this\.handleMessage\(next\)/, "重放必须走完整的 handleMessage 分诊");
});

test("queue has an explicit cap; full queue replies instead of failing silently", () => {
	assert.match(bridge, /const PENDING_QUEUE_MAX = 20;/);
	assert.match(bridge, /queue\.length >= PENDING_QUEUE_MAX/);
	assert.match(bridge, /"queue\.full"/);
});

test("content dedup is gone; idempotency keys only", () => {
	assert.doesNotMatch(bridge, /recentContent/, "5s 同文本去重必须移除（会吞用户主动连发的相同文本）");
	assert.match(bridge, /recentEventIds/);
	assert.match(bridge, /recentMessageIds/);
});

test("/stop and disconnect clear the pending queues", () => {
	const stopFn = bridge.match(/private async handleStopCommand[\s\S]*?\n\t\}/);
	assert.ok(stopFn, "handleStopCommand 应存在");
	assert.match(stopFn[0], /pendingMessageQueues\.delete\(ctx\.chatId\)/, "/stop 必须清空该聊天的队列");
	const disconnect = bridge.match(/this\.recentEventIds\.clear\(\);[\s\S]*?\n\t\}/);
	assert.ok(disconnect, "断开清理块应存在");
	assert.match(disconnect[0], /pendingMessageQueues\.clear\(\)/, "断开必须作废所有队列");
});

test("queue and run-state copy exist in both locales", () => {
	for (const key of ["queue.accepted", "queue.full", "session.stoppedWithQueue", "status.run", "status.runIdle", "status.runRunning", "status.runBridgeOnly", "status.runBackendOnly", "status.queued"]) {
		const occurrences = i18n.split(`"${key}"`).length - 1;
		assert.equal(occurrences, 2, `${key} 必须在 zhCN 与 enUS 词典各出现一次`);
	}
});
