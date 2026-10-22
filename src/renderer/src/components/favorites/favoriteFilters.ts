import type { FavoriteEntry, FavoriteKind } from "../../../../shared/types";

/** 收藏页的筛选维度：全部 / 只回复 / 只划选片段。 */
export type FavoriteFilter = "all" | FavoriteKind;

/**
 * 收藏列表的本地筛选（纯函数，可离开 React 单测）：
 * query 同时匹配正文与来源会话标题（不区分大小写），filter 按 kind 收窄。
 */
export function filterFavorites(entries: readonly FavoriteEntry[], query: string, filter: FavoriteFilter): FavoriteEntry[] {
	const keyword = query.trim().toLowerCase();
	return entries.filter((entry) => {
		if (filter !== "all" && entry.kind !== filter) return false;
		if (!keyword) return true;
		if (entry.text.toLowerCase().includes(keyword)) return true;
		return (entry.sessionTitle ?? "").toLowerCase().includes(keyword);
	});
}
