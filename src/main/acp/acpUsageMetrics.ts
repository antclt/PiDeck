/**
 * ACP 会话用量指标（纯函数）：把 session/prompt 响应的实验性 usage 与适配层本地测得的
 * 回合耗时折算成 runtime 状态字段（token / 缓存 / 命中率 / TTFT / TPS）。
 *
 * 数据来源与局限（按「有就展示，没有就缺省」处理，不猜测）：
 * - `usage_update` 只带 used/size/cost（协议未定义 token 拆分），上下文与费用由它驱动；
 * - `PromptResponse.usage` 是 SDK 实验性字段，Qoder 等 CLI 实际返回
 *   { inputTokens, outputTokens, totalTokens }（不含缓存拆分）；按「本回合」口径累计；
 * - TTFT / 总耗时由适配层自己计时（回合派发 → 首个正文/思考 chunk；回合派发 → 结算），
 *   不依赖 agent 上报，任何流式 CLI 都有值。
 *
 * 口径与 pi/DSH 对齐：
 * - 缓存命中率 = cacheRead ÷ (input + cacheRead + cacheWrite)；
 * - tps = output ÷ 首个正文 chunk 到结算的时长；endToEndTps = output ÷ 回合总时长；
 * - 会话均值为「累计值之比」而不是逐回合算术平均（与 pi 的 sessionTps 同义）。
 */
export type AcpTurnUsage = {
	inputTokens: number;
	outputTokens: number;
	/** 缓存字段在实现间可缺省（Qoder 只报 input/output）：undefined = 未上报，不是 0。 */
	cacheRead?: number;
	cacheWrite?: number;
};

export type AcpUsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	/** 至少一个回合上报过缓存字段；false 时渲染层不显示缓存/命中率行（避免一串假 0）。 */
	cacheReported: boolean;
	/** 上报过 usage 的回合数。 */
	turns: number;
	/** 最新一次可计算命中率的回合值（0~100）；没有缓存样本时缺省。 */
	cacheHitLatest?: number;
	cacheHitSum: number;
	cacheHitSamples: number;
	/** 有输出 token 的回合累计解码时长（ms），会话 TPS 的分母。 */
	decodeMs: number;
	/** 有输出 token 的回合累计总时长（ms），会话端到端 TPS 的分母。 */
	totalMs: number;
};

/** 非负有限数；其它形态（null/字符串/NaN/负数）一律视为未上报。 */
function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 读取 session/prompt 响应的 usage。字段来自 SDK 实验性 Usage（cachedReadTokens /
 * cachedWriteTokens 在实现间可能缺省）；全零响应视为未上报，避免面板出现一排 0。
 */
export function readAcpTurnUsage(result: unknown): AcpTurnUsage | undefined {
	const usage = (result as { usage?: unknown } | undefined)?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	const raw = usage as Record<string, unknown>;
	const inputTokens = finiteNonNegative(raw.inputTokens) ?? 0;
	const outputTokens = finiteNonNegative(raw.outputTokens) ?? 0;
	const cacheRead = finiteNonNegative(raw.cachedReadTokens);
	const cacheWrite = finiteNonNegative(raw.cachedWriteTokens);
	if (inputTokens + outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0) <= 0) return undefined;
	return {
		inputTokens,
		outputTokens,
		...(cacheRead !== undefined ? { cacheRead } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
	};
}

/**
 * 缓存命中率（%）：cacheRead ÷ (input + cacheRead + cacheWrite)。
 * 缓存字段整体未上报时返回 undefined——不能把「没有缓存数据」当成 0% 命中。
 */
export function cacheHitPercentOf(usage: AcpTurnUsage): number | undefined {
	if (usage.cacheRead === undefined && usage.cacheWrite === undefined) return undefined;
	const denominator = usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (denominator <= 0) return undefined;
	return ((usage.cacheRead ?? 0) / denominator) * 100;
}

/**
 * 单回合性能快照。TTFT 只在收到正文/思考 chunk 时才有值（工具调用不算「首字」，
 * 与 pi 的 text delta 口径一致）；TPS 用「首个 chunk → 结算」的解码窗口。
 */
export function acpReplyPerf(input: { startedAt?: number; firstTextAt?: number; endedAt: number; usage?: AcpTurnUsage }): { ttftMs?: number; totalMs?: number; tps?: number; endToEndTps?: number } | undefined {
	const { startedAt, firstTextAt, endedAt, usage } = input;
	if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
	const totalMs = Math.max(0, endedAt - startedAt);
	const ttftMs = firstTextAt !== undefined && Number.isFinite(firstTextAt) ? Math.max(0, Math.min(totalMs, firstTextAt - startedAt)) : undefined;
	const outputTokens = usage?.outputTokens ?? 0;
	const decodeMs = Math.max(0, totalMs - (ttftMs ?? 0));
	const tps = outputTokens > 0 && decodeMs > 0 ? outputTokens / (decodeMs / 1000) : undefined;
	const endToEndTps = outputTokens > 0 && totalMs > 0 ? outputTokens / (totalMs / 1000) : undefined;
	return { ttftMs, totalMs, tps, endToEndTps };
}

/**
 * 累计一个回合的用量。没有 usage 的回合不产生累计（返回原值，保持 undefined）；
 * 有 usage 但 timing 缺省的回合仍累计 token，只是不计入会话 TPS 分母。
 */
export function accumulateAcpUsage(prev: AcpUsageTotals | undefined, usage: AcpTurnUsage | undefined, timing: { totalMs: number; ttftMs?: number } | undefined): AcpUsageTotals | undefined {
	if (!usage) return prev;
	const cacheHit = cacheHitPercentOf(usage);
	const totals: AcpUsageTotals = prev ?? {
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheReported: false,
		turns: 0,
		cacheHitSum: 0,
		cacheHitSamples: 0,
		decodeMs: 0,
		totalMs: 0,
	};
	const next: AcpUsageTotals = {
		inputTokens: totals.inputTokens + usage.inputTokens,
		outputTokens: totals.outputTokens + usage.outputTokens,
		cacheRead: totals.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: totals.cacheWrite + (usage.cacheWrite ?? 0),
		cacheReported: totals.cacheReported || usage.cacheRead !== undefined || usage.cacheWrite !== undefined,
		turns: totals.turns + 1,
		cacheHitSum: totals.cacheHitSum + (cacheHit ?? 0),
		cacheHitSamples: totals.cacheHitSamples + (cacheHit !== undefined ? 1 : 0),
		decodeMs: totals.decodeMs,
		totalMs: totals.totalMs,
		// 最新命中率：本回合没有缓存样本（如 Qoder 只报 input/output）时保留上一次的值。
		...(cacheHit !== undefined ? { cacheHitLatest: cacheHit } : totals.cacheHitLatest !== undefined ? { cacheHitLatest: totals.cacheHitLatest } : {}),
	};
	if (timing && usage.outputTokens > 0) {
		next.decodeMs += Math.max(0, timing.totalMs - (timing.ttftMs ?? 0));
		next.totalMs += Math.max(0, timing.totalMs);
	}
	return next;
}

/** 会话平均 TPS（累计 output ÷ 累计解码/总时长）；无输出样本时整组缺省。 */
export function acpSessionTps(totals: AcpUsageTotals | undefined): { sessionTps?: number; sessionEndToEndTps?: number } {
	if (!totals || totals.outputTokens <= 0) return {};
	return {
		...(totals.decodeMs > 0 ? { sessionTps: totals.outputTokens / (totals.decodeMs / 1000) } : {}),
		...(totals.totalMs > 0 ? { sessionEndToEndTps: totals.outputTokens / (totals.totalMs / 1000) } : {}),
	};
}
