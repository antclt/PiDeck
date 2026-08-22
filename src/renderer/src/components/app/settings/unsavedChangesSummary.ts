import { t, type TranslationKey } from "../../../i18n";

/**
 * 设置关闭确认里要指出「哪个 tab 的哪一项」。
 * 字段按设置页从左到右、从上到下排列，而不是 dirty Set 的插入顺序——
 * 用户可能先改外观再改语言，但「常用设置」里的项更容易对上导航。
 * 多项只展示第一条，另用 totalCount 提示还有别的。
 */

export type SettingsUnsavedTabId =
	| "common"
	| "appearance"
	| "proxy"
	| "dev"
	| "im"
	| "pet"
	| "storage"
	| "usage"
	| "process"
	| "vision";

export type SettingsUnsavedSummary = {
	tabKey: TranslationKey;
	itemKey: TranslationKey;
	totalCount: number;
};

type FieldCatalogEntry = {
	field: string;
	tab: SettingsUnsavedTabId;
	itemKey: TranslationKey;
};

const TAB_LABEL_KEYS: Record<SettingsUnsavedTabId, TranslationKey> = {
	common: "settings.tabs.common",
	appearance: "settings.tabs.appearance",
	proxy: "settings.tabs.proxy",
	dev: "settings.tabs.dev",
	im: "settings.tabs.im",
	pet: "settings.tabs.pet",
	storage: "settings.tabs.storage",
	usage: "settings.tabs.usage",
	process: "settings.tabs.process",
	vision: "settings.tabs.vision",
};

/**
 * 同一控件会同时改多个 AppSettings key 时合成一项，避免「Git 摘要模型」显示成两项。
 */
const FIELD_CATALOG: readonly FieldCatalogEntry[] = [
	{ field: "language", tab: "common", itemKey: "settings.language" },
	{ field: "sessionTabOpenMode", tab: "common", itemKey: "settings.sessionTabOpenMode" },
	{ field: "sendShortcut", tab: "common", itemKey: "settings.inputShortcut" },
	{ field: "defaultAgentBackend", tab: "common", itemKey: "settings.defaultAgentBackend" },
	{ field: "linkOpenMode", tab: "common", itemKey: "settings.linkOpenMode" },
	{ field: "workspaceContentOpenMode", tab: "common", itemKey: "settings.workspaceContentOpenMode" },
	{ field: "expandInterimDuringStream", tab: "common", itemKey: "settings.expandInterimDuringStream" },
	{ field: "collapsePrevRunsOnNewTurn", tab: "common", itemKey: "settings.collapsePrevRunsOnNewTurn" },
	{ field: "expandTurnFileChanges", tab: "common", itemKey: "settings.expandTurnFileChanges" },
	{ field: "enableNotifications", tab: "common", itemKey: "settings.enableNotifications" },
	{ field: "agentCountReminderEnabled", tab: "common", itemKey: "settings.agentCountReminder" },
	{ field: "startupWindowMode", tab: "common", itemKey: "settings.startupWindowMode" },
	{ field: "closeToTray", tab: "common", itemKey: "settings.closeToTray" },
	{ field: "singleInstance", tab: "common", itemKey: "settings.singleInstance" },
	{ field: "enableGitManagement", tab: "common", itemKey: "settings.gitManagement" },
	{ field: "gitCommitMessageProvider", tab: "common", itemKey: "settings.gitCommitMessageModel" },
	{ field: "gitCommitMessageModel", tab: "common", itemKey: "settings.gitCommitMessageModel" },
	{ field: "favoriteModels", tab: "common", itemKey: "settings.gitCommitMessageModel" },
	{ field: "gitCommitMessagePrompt", tab: "common", itemKey: "settings.gitCommitMessagePrompt" },

	{ field: "theme", tab: "appearance", itemKey: "settings.theme" },
	{ field: "themeScheduleLightStart", tab: "appearance", itemKey: "settings.themeScheduleRange" },
	{ field: "themeScheduleDarkStart", tab: "appearance", itemKey: "settings.themeScheduleRange" },
	{ field: "accent", tab: "appearance", itemKey: "settings.accent" },
	{ field: "backgroundImage", tab: "appearance", itemKey: "settings.backgroundImage" },
	{ field: "backgroundImageOpacity", tab: "appearance", itemKey: "settings.backgroundImage" },
	{ field: "zoomFactor", tab: "appearance", itemKey: "settings.zoomFactor" },
	{ field: "fontSize", tab: "appearance", itemKey: "settings.fontSize" },
	{ field: "uiFontSize", tab: "appearance", itemKey: "settings.uiFontSize" },
	{ field: "chatFontSize", tab: "appearance", itemKey: "settings.chatFontSize" },
	{ field: "inputFontSize", tab: "appearance", itemKey: "settings.inputFontSize" },
	{ field: "fontFamilyBase", tab: "appearance", itemKey: "settings.fontFamilyBase" },
	{ field: "fontFamilyBaseCustom", tab: "appearance", itemKey: "settings.fontFamilyBaseCustomField" },
	{ field: "fontFamilyMono", tab: "appearance", itemKey: "settings.fontFamilyMono" },
	{ field: "fontFamilyMonoCustom", tab: "appearance", itemKey: "settings.fontFamilyMonoCustomField" },
	{ field: "chatContentWidthPct", tab: "appearance", itemKey: "settings.contentWidthPct" },
	{ field: "contentMaxWidth", tab: "appearance", itemKey: "settings.contentWidthPct" },
	{ field: "useNativeTitleBar", tab: "appearance", itemKey: "settings.nativeTitleBar" },
	{ field: "showNativeMenu", tab: "appearance", itemKey: "settings.nativeMenu" },

	{ field: "piProxyEnabled", tab: "proxy", itemKey: "settings.enablePiProxy" },
	{ field: "piProxyUrl", tab: "proxy", itemKey: "settings.proxyUrl" },
	{ field: "piProxyBypass", tab: "proxy", itemKey: "settings.proxyBypass" },
	{ field: "piProxyProviders", tab: "proxy", itemKey: "settings.piProxyProviders" },
	{ field: "desktopProxyEnabled", tab: "proxy", itemKey: "settings.enableDesktopProxy" },
	{ field: "desktopProxyUrl", tab: "proxy", itemKey: "settings.proxyUrl" },
	{ field: "desktopProxyBypass", tab: "proxy", itemKey: "settings.proxyBypass" },

	{ field: "wslEnabled", tab: "dev", itemKey: "settings.piSource.label" },
	{ field: "wslDistro", tab: "dev", itemKey: "settings.wsl.distro" },
	{ field: "wslUser", tab: "dev", itemKey: "settings.wsl.user" },
	{ field: "customPiPath", tab: "dev", itemKey: "settings.customPiPath" },
	{ field: "disableUpdateCheck", tab: "dev", itemKey: "settings.disableUpdateCheck" },
	{ field: "rpcTimeout", tab: "dev", itemKey: "settings.rpcTimeout" },
	{ field: "maxEditorFileSizeMB", tab: "dev", itemKey: "settings.maxEditorFileSize" },
	{ field: "electronChromiumSandbox", tab: "dev", itemKey: "settings.electronSandbox" },
	{ field: "piRpcOffline", tab: "dev", itemKey: "settings.piRpcOffline" },
	{ field: "piRpcNoExtensions", tab: "dev", itemKey: "settings.piRpcNoExtensions" },
	{ field: "piRpcNoSkills", tab: "dev", itemKey: "settings.piRpcNoSkills" },
	{ field: "webServiceEnabled", tab: "dev", itemKey: "settings.enableWebService" },
	{ field: "webServiceHost", tab: "dev", itemKey: "settings.webServiceHost" },
	{ field: "webServicePort", tab: "dev", itemKey: "settings.webServicePort" },
	{ field: "externalEditors", tab: "dev", itemKey: "settings.sectionEditors" },
	{ field: "developerDiagnostics", tab: "dev", itemKey: "settings.developerDiagnostics" },
	{ field: "telemetryEnabled", tab: "dev", itemKey: "settings.telemetry" },

	{ field: "petEnabled", tab: "pet", itemKey: "settings.pet.enable" },
	{ field: "petAlwaysOnTop", tab: "pet", itemKey: "settings.pet.alwaysOnTop" },
	{ field: "petPatrolEnabled", tab: "pet", itemKey: "settings.pet.patrol" },
	{ field: "petPatrolPauseMin", tab: "pet", itemKey: "settings.pet.patrolPause" },
	{ field: "petScale", tab: "pet", itemKey: "settings.pet.scale" },
	{ field: "petId", tab: "pet", itemKey: "settings.pet.choose" },
];

const UNKNOWN_ITEM: FieldCatalogEntry = {
	field: "*",
	tab: "common",
	itemKey: "settings.unsavedUnknownItem",
};

function itemIdentity(tab: SettingsUnsavedTabId, itemKey: TranslationKey): string {
	return `${tab}\0${itemKey}`;
}

/**
 * 把 dirty 字段收成关闭确认要用的一条摘要。
 * visionDirty 不是 AppSettings 字段（写 pi-deck-vision.json），单独挂到视觉桥 tab。
 */
export function summarizeSettingsUnsavedChanges(input: {
	dirtyFields: Iterable<string>;
	visionDirty?: boolean;
}): SettingsUnsavedSummary | null {
	const dirty = new Set(input.dirtyFields);
	const seen = new Set<string>();
	const items: Array<{ tab: SettingsUnsavedTabId; itemKey: TranslationKey }> = [];

	const push = (tab: SettingsUnsavedTabId, itemKey: TranslationKey) => {
		const id = itemIdentity(tab, itemKey);
		if (seen.has(id)) return;
		seen.add(id);
		items.push({ tab, itemKey });
	};

	for (const entry of FIELD_CATALOG) {
		if (!dirty.has(entry.field)) continue;
		dirty.delete(entry.field);
		push(entry.tab, entry.itemKey);
	}

	// 未建目录的内部字段（侧栏展开态等）不值得逐条点名，合成「其他选项」一项。
	if (dirty.size > 0) {
		push(UNKNOWN_ITEM.tab, UNKNOWN_ITEM.itemKey);
	}

	if (input.visionDirty) {
		push("vision", "settings.vision.section");
	}

	const first = items[0];
	if (!first) return null;
	return {
		tabKey: TAB_LABEL_KEYS[first.tab],
		itemKey: first.itemKey,
		totalCount: items.length,
	};
}

/** 左侧导航要打黄点的 tab：按字段目录归并，视觉桥草稿单独算 vision。 */
export function dirtySettingsTabIds(input: {
	dirtyFields: Iterable<string>;
	visionDirty?: boolean;
}): Set<SettingsUnsavedTabId> {
	const dirty = new Set(input.dirtyFields);
	const tabs = new Set<SettingsUnsavedTabId>();
	for (const entry of FIELD_CATALOG) {
		if (dirty.has(entry.field)) tabs.add(entry.tab);
	}
	if (input.visionDirty) tabs.add("vision");
	return tabs;
}

export function formatSettingsUnsavedMessage(
	summary: SettingsUnsavedSummary | null,
	translate: typeof t = t,
): string {
	if (!summary) return translate("settings.unsavedMessage");
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
