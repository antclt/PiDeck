import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 侧栏计时点（相对时间的基准时刻）纯规则单测。
 *
 * 产品定义：一次计时点 = 「用户最后一条输入」或「上一轮 turn 结束」。这里只验证两条规则：
 * 1. 本轮是否在跑（优先 isTurnActive，缺该字段的后端退回运行状态）；
 * 2. 只有「在跑 ⇄ 未跑」的边沿才推进计时点——中间态与首次观测到空闲都不推进。
 */

const { isSessionTurnRunning, nextSessionActivityAnchor, shouldMarkRuntimeRunningAfterSend } = loadTsCommonJs("src/renderer/src/utils/sessionActivityClock.ts");

test("isTurnActive is the authority when the backend reports it", () => {
	// pi：agent_end 之后进程可能仍在收尾（status=running），但这一轮已经结束。
	assert.equal(isSessionTurnRunning({ isTurnActive: true }, "running"), true);
	assert.equal(isSessionTurnRunning({ isTurnActive: false }, "running"), false);
	// 工具循环间隙里 isStreaming 会闪断，isTurnActive 不受影响。
	assert.equal(isSessionTurnRunning({ isTurnActive: true }, "idle"), true);
});

test("backends without isTurnActive fall back to the run status", () => {
	assert.equal(isSessionTurnRunning(undefined, "running"), true);
	assert.equal(isSessionTurnRunning(undefined, "starting"), true);
	assert.equal(isSessionTurnRunning(undefined, "idle"), false);
	assert.equal(isSessionTurnRunning({}, "idle"), false);
});

test("terminal statuses close the turn even with a stale isTurnActive", () => {
	assert.equal(isSessionTurnRunning({ isTurnActive: true }, "closed"), false);
	assert.equal(isSessionTurnRunning({ isTurnActive: true }, "error"), false);
	assert.equal(isSessionTurnRunning({ isTurnActive: true }, "detached"), false);
});

test("send result only marks running for backends that ack on dispatch", () => {
	// pi/DSH 的 IPC 在派发时返回：补写 running 让底栏立刻进入运行态。
	assert.equal(shouldMarkRuntimeRunningAfterSend({ accepted: true, backend: "pi" }), true);
	assert.equal(shouldMarkRuntimeRunningAfterSend({ accepted: true, backend: "dsh" }), true);
	// ACP 的 IPC 要等整轮结束才返回：此时 status 已由 manager 推成 idle，绝不能再写 running；
	// 否则下一次预测采纳后的发送会被误判忙碌、排进 followUp 队列。
	assert.equal(shouldMarkRuntimeRunningAfterSend({ accepted: true, backend: "acp" }), false);
	assert.equal(shouldMarkRuntimeRunningAfterSend({ accepted: false, backend: "acp" }), false);
	assert.equal(shouldMarkRuntimeRunningAfterSend({ accepted: false, backend: "pi" }), false);
});

test("turn start and turn end both move the timing point", () => {
	assert.equal(nextSessionActivityAnchor({ previousRunning: false, running: true, now: 1000 }), 1000);
	assert.equal(nextSessionActivityAnchor({ previousRunning: true, running: false, now: 2000 }), 2000);
});

test("streaming middle states keep the existing timing point", () => {
	// running → running：流式 token、工具调用、标题回写都不该重置计时器。
	assert.equal(nextSessionActivityAnchor({ previousRunning: true, running: true, now: 3000 }), undefined);
	// 首次观测到一个空闲会话：没有边界发生，不能让历史行全部变成「刚刚」。
	assert.equal(nextSessionActivityAnchor({ previousRunning: false, running: false, now: 4000 }), undefined);
});
