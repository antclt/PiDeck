/**
 * 应用公告 atoms（session-first 之外的轻量全局域：公告是应用级而非会话级信息）。
 * 快照由主进程推送（useAnnouncementsSync 订阅），渲染层只做未读差集这类纯派生。
 */
import { atom } from "jotai";
import type { AnnouncementItem, AnnouncementState } from "../../../shared/types/announcement";

/** 主进程公告快照（含已读集合）；null = 尚未收到任何快照（启动极早期）。 */
export const announcementStateAtom = atom<AnnouncementState | null>(null);

/**
 * 未读公告列表（快照 items 与 readIds 的差集，保持快照顺序 = 发布时间倒序）。
 * 红点/角标与弹窗未读标记共用此派生，避免两处各算一遍。
 */
export const unreadAnnouncementsAtom = atom<AnnouncementItem[]>((get) => {
	const state = get(announcementStateAtom);
	if (!state) return [];
	const read = new Set(state.readIds);
	return state.items.filter((item) => !read.has(item.id));
});

/**
 * 公告中心弹窗开关（atom 驱动而非组件内 useState）：
 * toast「查看」按钮在任意位置都能打开公告中心，状态必须提升为全局单一 owner。
 */
export const announcementCenterOpenAtom = atom(false);
