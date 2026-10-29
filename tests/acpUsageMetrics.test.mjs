import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * ACP 会话用量指标（底栏「用量」圆环面板的数据源）。
 *
 * 背景（2027-03）：ACP 会话此前只有上下文与费用，输入/输出 tokens、TTFT、耗时、
 * TPS 全部缺失。pi/DSH 的口径不能照搬 agent 上报之外的猜测，所以这里按
 * 「CLI 有就展示、没有就缺省」实现：session/prompt 的实验性 usage 提供 token，
 * TTFT/总耗时由适配层本地计时。
 */

const { readAcpTurnUsage, cacheHitPercentOf, acpReplyPerf, accumulateAcpUsage, acpSessionTps } = loadTsCommonJs("src/main/acp/acpUsageMetrics.ts");

test("readAcpTurnUsage: 读取 Qoder 形态的 input/output（无缓存拆分）", () => {
	const usage = readAcpTurnUsage({ stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } });
	assert.deepEqual({ ...usage }, { inputTokens: 1200, outputTokens: 340 });
	// 缓存字段缺失是合法形态（Qoder 只报 input/output），命中率必须缺省而不是 0%。
	assert.equal(usage.cacheRead, undefined);
	assert.equal(cacheHitPercentOf(usage), undefined);
});

test("readAcpTurnUsage: 缺失/非法/全零响应不产生指标", () => {
	assert.equal(readAcpTurnUsage(undefined), undefined);
	assert.equal(readAcpTurnUsage({}), undefined);
	assert.equal(readAcpTurnUsage({ usage: null }), undefined);
	assert.equal(readAcpTurnUsage({ usage: { inputTokens: 0, outputTokens: 0 } }), undefined);
	assert.equal(readAcpTurnUsage({ usage: { inputTokens: -1, outputTokens: Number.NaN } }), undefined);
});

test("readAcpTurnUsage + 命中率: 带缓存拆分的实现按 pi/DSH 同公式计算", () => {
	const usage = readAcpTurnUsage({ usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 300, cachedWriteTokens: 20 } });
	assert.deepEqual({ ...usage }, { inputTokens: 100, outputTokens: 50, cacheRead: 300, cacheWrite: 20 });
	// 300 ÷ (100 + 300 + 20) = 71.43%
	assert.ok(Math.abs(cacheHitPercentOf(usage) - 71.4285714) < 1e-4);
});

test("acpReplyPerf: TTFT 到首个正文 chunk，TPS 用解码窗口、端到端用总时长", () => {
	const perf = acpReplyPerf({ startedAt: 1000, firstTextAt: 1500, endedAt: 4000, usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(perf.ttftMs, 500);
	assert.equal(perf.totalMs, 3000);
	assert.equal(perf.tps, 120); // 300 / 2.5s
	assert.equal(perf.endToEndTps, 100); // 300 / 3s
	// 没有正文 chunk（纯工具回合）时 TTFT 缺省，TPS 仍按总时长计。
	const toolOnly = acpReplyPerf({ startedAt: 1000, endedAt: 2000, usage: { inputTokens: 10, outputTokens: 40, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(toolOnly.ttftMs, undefined);
	assert.equal(toolOnly.tps, 40);
});

test("accumulateAcpUsage: 累计 token 并给出平均命中率与会话 TPS", () => {
	const first = accumulateAcpUsage(undefined, { inputTokens: 100, outputTokens: 50, cacheRead: 300, cacheWrite: 20 }, { totalMs: 2000, ttftMs: 500 });
	const second = accumulateAcpUsage(first, { inputTokens: 200, outputTokens: 100 }, { totalMs: 1000, ttftMs: 200 });
	assert.equal(second.inputTokens, 300);
	assert.equal(second.outputTokens, 150);
	assert.equal(second.cacheRead, 300);
	assert.equal(second.cacheWrite, 20);
	assert.equal(second.turns, 2);
	// 只有第一回合有缓存样本：平均命中率 = 单样本命中率，第二回合不把 0 混进平均。
	assert.equal(second.cacheHitSamples, 1);
	assert.ok(Math.abs(second.cacheHitSum / second.cacheHitSamples - 71.4285714) < 1e-4);
	const session = acpSessionTps(second);
	assert.ok(session.sessionTps > 0);
	assert.ok(session.sessionEndToEndTps > 0);
	// 没有 usage 的回合不改累计（保持 undefined）。
	assert.equal(accumulateAcpUsage(undefined, undefined, { totalMs: 1000 }), undefined);
});

test("buildAgentRuntimeState: usageTotals/lastReplyPerf 映射到渲染层字段", () => {
	const { buildAgentRuntimeState } = loadTsCommonJs("src/main/acp/acpAgentRuntime.ts");
	const totals = accumulateAcpUsage(undefined, { inputTokens: 100, outputTokens: 50, cacheRead: 300, cacheWrite: 20 }, { totalMs: 2000, ttftMs: 500 });
	const state = buildAgentRuntimeState({
		tab: { id: "acp-1" },
		tool: { id: "qoder", name: "Qoder CLI CN" },
		turnActive: false,
		projection: { usage: { used: 12_000, size: 200_000, costAmount: 0.02 }, messages: [] },
		usageTotals: totals,
		lastReplyPerf: { ttftMs: 500, totalMs: 2000, tps: 33.3, endToEndTps: 25, at: 1 },
	});
	assert.equal(state.contextTokens, 12_000);
	assert.equal(state.contextWindow, 200_000);
	assert.equal(state.cost, 0.02);
	assert.equal(state.inputTokens, 100);
	assert.equal(state.outputTokens, 50);
	assert.equal(state.cacheRead, 300);
	assert.equal(state.cacheWrite, 20);
	assert.equal(state.cacheTotal, 320);
	assert.equal(state.cacheHitSampleCount, 1);
	assert.ok(state.cacheHitPercent > 0);
	assert.ok(state.cacheHitAveragePercent > 0);
	assert.equal(state.ttftMs, 500);
	assert.equal(state.totalMs, 2000);
	assert.equal(state.tps, 33.3);
	assert.equal(state.endToEndTps, 25);
	assert.ok(state.sessionTps > 0);
});

test("buildAgentRuntimeState: CLI 不报 usage 时 token/缓存整组缺省（不展示 0）", () => {
	const { buildAgentRuntimeState } = loadTsCommonJs("src/main/acp/acpAgentRuntime.ts");
	const state = buildAgentRuntimeState({
		tab: { id: "acp-2" },
		tool: { id: "gemini", name: "Gemini CLI" },
		turnActive: false,
		projection: { usage: { used: 500, size: 100_000 }, messages: [] },
		lastReplyPerf: { totalMs: 800, at: 1 },
	});
	assert.equal(state.inputTokens, undefined);
	assert.equal(state.outputTokens, undefined);
	assert.equal(state.cacheRead, undefined);
	assert.equal(state.cacheHitPercent, undefined);
	assert.equal(state.sessionTps, undefined);
	assert.equal(state.totalMs, 800);
});
