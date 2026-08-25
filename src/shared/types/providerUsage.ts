/**
 * Provider 用量/余额查询结果（主进程 ProviderUsageService 产出）。
 *
 * 各 provider 的用量接口形态差异很大，Ui 只消费统一后的字段：
 * - percent 优先：opencode-go /v1/usage 直接给出三档占用百分比（滚动/周/月）。
 * - raw 兜底：解析不出的字段原样保留，供 UI 展示或者留待后续适配。
 */
export type ProviderUsagePeriod = {
	/** 该档位用量百分比（0-100）；未知时省略。 */
	percent?: number;
	/** 该档位重置时间（ISO 字符串）；未知时省略。 */
	resetsAt?: string;
	/** 该档位可用状态（如 "ok" / "trial" / "over-quota"）；opencode-go 原样透传。 */
	status?: string;
};

export type ProviderUsageResult = {
	success: boolean;
	/** provider 名（渲染层传入，原样带回，用于面板标题）。 */
	provider?: string;
	/** 三档用量（opencode-go 语义：rolling 滚动窗口 / weekly / monthly）。 */
	periods?: Partial<Record<"rolling" | "weekly" | "monthly", ProviderUsagePeriod>>;
	/** 无法结构化解析时保留的原始响应体（已脱敏/截断，可安全展示）。 */
	raw?: string;
	/** 失败原因（主进程本地文案或 HTTP 错误摘要）。 */
	error?: string;
	/** 查询时刻（Date.now()），渲染层据此判断数据新旧。 */
	at?: number;
};