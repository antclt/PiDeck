import type { SettingsTabId } from "../../../atoms";

/**
 * 设置页侧栏展示布局：tab 顺序 + 分组分割线位置。
 * 只影响视觉呈现，不改变 SettingsTabId 本身——深链（settingsFocusAtom）、
 * localStorage 记忆位置、脏标记黄点都仍按 tab id 工作。
 *
 * 13 个 tab 平铺不易扫读，按「基础 → 扩展集成 → 数据与监控 → 开发者」四个簇
 * 重排并在簇边界渲染一条分割线：
 * - 基础：常用 / 外观 / 代理（打开应用必看的全局项）
 * - 扩展集成：飞书机器人 / 桌面宠物 / 视觉桥 / 生图（外部能力与增值功能）
 * - 数据与监控：缓存与日志 / 用量统计 / 进程监控
 * - 开发者：局域网 Web 服务 / 外部编辑器 / Git / 开发设置（环境、版本、调试等低频项，置底）
 *
 * 局域网 Web 服务、外部编辑器与 Git 设置原为其它 tab 内的区块，因用户频繁使用
 * 单独抽为 tab，仍留在开发者簇（紧随其后的 dev 保持分割线，簇边界不变）。
 */
export type SettingsTabLayoutEntry = {
	id: SettingsTabId;
	/** 渲染此 tab 前是否先插入分组分割线；纯视觉标记，首项必须缺省 */
	dividerBefore?: boolean;
};

export const SETTINGS_TAB_LAYOUT: readonly SettingsTabLayoutEntry[] = [
	{ id: "common" },
	{ id: "appearance" },
	{ id: "proxy" },
	{ id: "im", dividerBefore: true },
	{ id: "pet" },
	{ id: "vision" },
	{ id: "imagegen" },
	{ id: "storage", dividerBefore: true },
	{ id: "usage" },
	{ id: "process" },
	{ id: "web" },
	{ id: "editors" },
	{ id: "git" },
	{ id: "dev", dividerBefore: true },
];

/** 全部合法 tab id（顺序即展示顺序）：校验 localStorage 记忆值、防止旧版本残留值导致无高亮。 */
export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = SETTINGS_TAB_LAYOUT.map(
	(entry) => entry.id,
);
