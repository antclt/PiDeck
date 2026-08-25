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
	credits?: { total?: number; used?: number; remaining?: number };
	/** 无法结构化解析时保留的原始响应体（已脱敏/截断，可安全展示）。 */
	raw?: string;
	/** 失败原因（主进程本地文案或 HTTP 错误摘要）。 */
	error?: string;
	/** 查询时刻（Date.now()），渲染层据此判断数据新旧。 */
	at?: number;
};
