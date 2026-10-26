import type { WhitelistSkip } from "./PiProcess";

/**
 * 白名单被跳过时给用户看的文案元数据（i18n key + 中文标签）。
 *
 * 三类白名单（扩展/技能/提示词）共用同一条命令行预算，跳过语义完全一致：
 * 「这次启动没按你的禁用设置来，pi 按默认发现加载了全部 X」。但用户视角里这三件事
 * 互相独立，所以文案按 kind 分开，避免一句话里混着两种资源让人误判成同一件事。
 */
export const WHITELIST_SKIP_KIND_COPY: Record<WhitelistSkip["kind"], { i18nKey: string; label: string; setting: string }> = {
	extensions: {
		i18nKey: "diagnostic.extensionWhitelistSkipped",
		label: "扩展",
		setting: "「禁用扩展」",
	},
	skills: {
		// 保持既有 key 不变：技能是首个接入预算守卫的类型，历史上已落到用户时间线里。
		i18nKey: "diagnostic.skillWhitelistSkipped",
		label: "技能",
		setting: "「禁用技能」",
	},
	prompts: {
		i18nKey: "diagnostic.promptWhitelistSkipped",
		label: "提示词模板",
		setting: "「禁用提示词」",
	},
};

/** 某类白名单被跳过时的兜底文本（i18n 缺失时使用，含条数与预算便于用户自查）。 */
export function resolveWhitelistSkipCopy(entry: WhitelistSkip): {
	i18nKey: string;
	fallbackText: string;
} {
	const meta = WHITELIST_SKIP_KIND_COPY[entry.kind];
	return {
		i18nKey: meta.i18nKey,
		fallbackText: `${meta.label}数量过多（${entry.count} 个，约 ${entry.chars} 字符，超出启动参数预算 ${entry.budget}），` + `已跳过${meta.setting}设置：本次启动由 pi 自动加载全部${meta.label}。`,
	};
}
