import assert from "node:assert/strict";
import test from "node:test";
import { deriveRetryProgress } from "../src/renderer/src/components/session/timeline/retryProgress.ts";

/**
 * 状态条的重试进度直接读时间线上的重试卡（pi auto_retry / DSH llm/retry 同款卡片），
 * 不再另外上报运行时字段：卡片 running = 正在重试，settled = 已收口。
 */

function retryCard({ id = "retry-1", key = "diagnostic.retryScheduledAfterDelay", status = "running", attempt = 1, maxAttempts = 3, delayMs = 5000, timestamp = 1000 } = {}) {
	return { id, agentId: "agent-1", role: "system", text: "", timestamp, meta: { i18nKey: key, status, attempt, maxAttempts, delayMs } };
}

function userMessage(text = "你好") {
	return { id: `user-${text}`, agentId: "agent-1", role: "user", text, timestamp: 0 };
}

test("running 的重试卡给出真实重试序号与下一次尝试时刻", () => {
	assert.deepEqual(deriveRetryProgress([userMessage(), retryCard({ attempt: 2, maxAttempts: 5 })]), { attempt: 2, maxAttempts: 5, retryAtMs: 6000 });
	// 无延迟分支（retryScheduled）同样是进行中
	assert.deepEqual(deriveRetryProgress([retryCard({ key: "diagnostic.retryScheduled", attempt: 1, maxAttempts: 2 })]), { attempt: 1, maxAttempts: 2, retryAtMs: 6000 });
});

test("没有退避延迟就不给倒计时终点（立即重试不读秒）", () => {
	assert.deepEqual(deriveRetryProgress([retryCard({ delayMs: 0 })]), { attempt: 1, maxAttempts: 3, retryAtMs: undefined });
});

test("上限缺失时只报序号，不猜分母", () => {
	assert.deepEqual(deriveRetryProgress([retryCard({ attempt: 3, maxAttempts: 0 })]), { attempt: 3, maxAttempts: undefined, retryAtMs: 6000 });
	// 主进程的卡片一定带 attempt（AgentManager.upsertRetryStatusMessage 里 `event.attempt ?? 0`），
	// 真读不到序号时不进入重试态，避免出现“正在重试 0/…”这种假文案。
	assert.equal(deriveRetryProgress([{ ...retryCard(), meta: { i18nKey: "diagnostic.retryScheduled", status: "running", maxAttempts: 3 } }]), undefined);
});

test("已收口的重试卡不算进行中", () => {
	assert.equal(deriveRetryProgress([retryCard({ key: "diagnostic.retrySucceeded", status: "success" })]), undefined);
	assert.equal(deriveRetryProgress([retryCard({ key: "diagnostic.retryFailed", status: "error" })]), undefined);
});

test("只认尾部最后一张重试卡：上一轮已成功的卡不能粘住本轮状态", () => {
	// 同一轮 run 内多次失败会各留一张卡，只有尾部那张代表当前状态。
	assert.deepEqual(deriveRetryProgress([retryCard({ id: "retry-old", status: "success", key: "diagnostic.retrySucceeded" }), userMessage("第二轮"), retryCard({ id: "retry-2", attempt: 1, maxAttempts: 3 })]), { attempt: 1, maxAttempts: 3, retryAtMs: 6000 });
	// 尾部那张已收敛 → 本轮重试结束，即使更早还有 running 卡也不看
	assert.equal(deriveRetryProgress([retryCard({ id: "retry-new", key: "diagnostic.retryFailed", status: "error" }), retryCard({ id: "retry-done", key: "diagnostic.retrySucceeded", status: "success" })]), undefined);
});

test("没有重试卡 / 空消息列表返回 undefined", () => {
	assert.equal(deriveRetryProgress([]), undefined);
	assert.equal(deriveRetryProgress(undefined), undefined);
	assert.equal(deriveRetryProgress([userMessage(), { id: "assistant-1", agentId: "agent-1", role: "assistant", text: "在做", timestamp: 2 }]), undefined);
});
