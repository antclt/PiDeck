import { t, type TranslationKey } from "../i18n";

/**
 * Pi / DSH 配置关闭确认：点名第一个脏 tab。
 * 配置页大多是整页草稿（没有设置页那样的字段黄点目录），所以 item 用该 tab 自己的导航名。
 * DSH 子页脏标记是 `dsh:<navId>`；Pi 侧与 dirtyTabs 编码一致。
 */

export type ConfigUnsavedSummary = {
	tabKey: TranslationKey;
	itemKey: TranslationKey;
	totalCount: number;
};

type CatalogEntry = {
	match: (key: string) => boolean;
	tabKey: TranslationKey;
	itemKeyFor: (key: string) => TranslationKey;
};

const DSH_NAV_ITEM_KEYS: Record<string, TranslationKey> = {
	overview: "config.dsh.tab.overview",
	models: "config.dsh.tab.models",
	presets: "config.dsh.tab.presets",
	plugins: "config.dsh.tab.plugins",
	security: "config.dsh.tab.security",
	auth: "config.dsh.tab.auth",
	raw: "config.dsh.tab.raw",
};

const CATALOG: readonly CatalogEntry[] = [
	{
		match: (key) => key === "dsh" || key.startsWith("dsh:"),
		tabKey: "config.backend.dsh",
		itemKeyFor: (key) => {
			if (key === "dsh") return "config.dsh.title";
			const nav = key.slice("dsh:".length).split(":")[0] ?? "";
			return DSH_NAV_ITEM_KEYS[nav] ?? "config.dsh.title";
		},
	},
	{ match: (key) => key === "config:models", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.models" },
	{ match: (key) => key === "config:auth", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.auth" },
	{ match: (key) => key === "config:settings", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.settings" },
	{ match: (key) => key === "config:trust", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.trust" },
	{ match: (key) => key === "config:raw", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.raw" },
	{ match: (key) => key === "security", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.security" },
	{ match: (key) => key === "imagegen", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.imagegen" },
	{ match: (key) => key === "extensions", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.extensions" },
	{ match: (key) => key === "skills", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.skills" },
	{ match: (key) => key === "prompts", tabKey: "config.backend.pi", itemKeyFor: () => "config.nav.prompts" },
];

function itemIdentity(tabKey: TranslationKey, itemKey: TranslationKey): string {
	return `${tabKey}\0${itemKey}`;
}

export function summarizeConfigUnsavedChanges(dirtyTabs: Iterable<string>): ConfigUnsavedSummary | null {
	const dirty = [...dirtyTabs];
	const seen = new Set<string>();
	const items: Array<{ tabKey: TranslationKey; itemKey: TranslationKey }> = [];

	for (const entry of CATALOG) {
		for (const key of dirty) {
			if (!entry.match(key)) continue;
			const tabKey = entry.tabKey;
			const itemKey = entry.itemKeyFor(key);
			const id = itemIdentity(tabKey, itemKey);
			if (seen.has(id)) continue;
			seen.add(id);
			items.push({ tabKey, itemKey });
		}
	}

	const first = items[0];
	if (!first) return null;
	return {
		tabKey: first.tabKey,
		itemKey: first.itemKey,
		totalCount: items.length,
	};
}

export function formatConfigUnsavedMessage(
	summary: ConfigUnsavedSummary | null,
	translate: typeof t = t,
): string {
	if (!summary) return translate("config.unsavedMessage");
	const tab = translate(summary.tabKey);
	const item = translate(summary.itemKey);
	if (summary.totalCount <= 1) {
		return translate("settings.unsavedMessageDetail", { tab, item });
	}
	return translate("settings.unsavedMessageMore", {
		tab,
		item,
		count: summary.totalCount,
	});
}
