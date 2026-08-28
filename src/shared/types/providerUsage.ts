/**
 * Provider 用量/余额查询结果（主进程 ProviderUsageService 产出，渲染层圆环面板消费）。
 *
 * 各 provider 的用量接口形态差异很大，这里统一成三类展示形态：
 * - periods：三档占用百分比（滚动/周/月），opencode-go /v1/usage 等网关语义；
 * - balance：剩余额度（金额 + 币种），DeepSeek /user/balance 等；
 * - credits：额度点数（总额/已用/剩余），OpenRouter /credits 等。
 * 解析不出任何形态时保留 raw（脱敏后）供调试；kind 显式标注形态，避免渲染层靠字段猜测。
 */
export type ProviderUsagePeriod = {
	/** 该档位用量百分比（0-100）；未知时省略。 */
	percent?: number;
	/** 该档位重置时间（ISO 字符串）；未知时省略。 */
	resetsAt?: string;
	/** 该档位可用状态（如 "ok" / "trial" / "over-quota"）；opencode-go 原样透传。 */
	status?: string;
};

export type ProviderUsageKind = "periods" | "balance" | "credits";

export type ProviderUsageCredits = {
	total?: number;
	used?: number;
	remaining?: number;
	/**
	 * 多窗口额度：同一 provider 的并列限额（如智谱 5h 滚动窗 + 周窗、
	 * xAI 套餐内额度 + 按需用量），各窗口是独立配额。
	 * 有则 UI 逐窗口展示（条 + 百分比）；无则仅主值。
	 */
	windows?: { key: string; total?: number; used?: number; remaining?: number }[];
};

/**
 * 独立货币额度（如 Kimi Coding 的 Boost 点数）：与主额度同响应、不同语义，
 * 单独展示而不混进主 credits 数值，避免误导用户当成同一单位的余额。
 * 所有金额字段统一为「元」或「点数主单位」的浮点数。
 */
export type ProviderUsageBooster = {
	/** 剩余余额（主单位，如元）。 */
	balance: number;
	/** 总额（主单位）；未知时省略。 */
	total?: number;
	/** 币种（如 CNY）；未知时省略。 */
	currency?: string;
	/** 本月已用（主单位）。 */
	monthlyUsed?: number;
	/** 月限额（主单位）；未启用或未知时省略。 */
	monthlyChargeLimit?: number;
	/** 月限额明确未启用（服务端返回 unlimited）。 */
	unlimitedMonthly?: boolean;
};

export type ProviderUsageResult = {
	success: boolean;
	/** provider 名（渲染层传入，原样带回，用于面板标题）。 */
	provider?: string;
	/** 解析出的展示形态；成功但未识别到任何形态时省略。 */
	kind?: ProviderUsageKind;
	/** kind=periods：三档用量。 */
	periods?: Partial<Record<"rolling" | "weekly" | "monthly", ProviderUsagePeriod>>;
	/** kind=balance：剩余额度（数值 + 可选币种）。 */
	balance?: { value: number; currency?: string };
	/** kind=credits：额度点数。remaining 优先展示；缺 remaining 时由 total-used 反推。 */
	credits?: ProviderUsageCredits;
	/** 与主额度并存的独立货币（如 Kimi Boost 点数）；有则 UI 追加展示。 */
	booster?: ProviderUsageBooster;
	/** 无法结构化解析时保留的原始响应体（已脱敏/截断，可安全展示）。 */
	raw?: string;
	/** 失败原因（主进程本地文案或 HTTP 错误摘要）。 */
	error?: string;
	/** 查询时刻（Date.now()），渲染层据此判断数据新旧。 */
	at?: number;
};
