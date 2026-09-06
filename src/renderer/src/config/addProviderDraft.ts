import { setHeaderValue } from "./providerHeaders";
import type { ProviderConfig } from "./configTypes";

/**
 * 新增供应商弹窗的草稿类型与草稿 → models.json provider 转换（纯函数，便于单测）。
 * 与 AddProviderDialog 组件分离：组件只负责收集字段，转换逻辑独立可测。
 */
export type AddProviderDraft = {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	userAgent: string;
	compat: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
	};
};

/**
 * 弹窗草稿 → models.json provider 配置。
 * 空字段不写入（与手写 models.json 一致）；User-Agent 走 headers；
 * compat 全 false 不写（与 pi 默认一致）；baseUrl 去除首尾空白。
 */
export function buildProviderConfigFromDraft(draft: AddProviderDraft): ProviderConfig {
	const provider: ProviderConfig = { models: [] };
	if (draft.baseUrl.trim()) provider.baseUrl = draft.baseUrl.trim();
	if (draft.api) provider.api = draft.api;
	if (draft.apiKey.trim()) provider.apiKey = draft.apiKey.trim();
	if (draft.userAgent.trim()) {
		provider.headers = setHeaderValue(undefined, "User-Agent", draft.userAgent);
	}
	if (draft.compat.supportsDeveloperRole || draft.compat.supportsReasoningEffort) {
		provider.compat = {
			supportsDeveloperRole: draft.compat.supportsDeveloperRole,
			supportsReasoningEffort: draft.compat.supportsReasoningEffort,
		};
	}
	return provider;
}
