import { atom } from "jotai";
import type { FavoriteEntry } from "../../../shared/types";
import { closeWorkspacePageAtom, openWorkspacePageAtom, workspacePageTabStateAtom } from "./workspace-page-atoms";

/**
 * 收藏列表（本机快照，主进程按收藏时间倒序返回）；null = 尚未从主进程读到。
 * 页面与各收藏入口共用这一个 atom：任意入口收藏/删除后列表立即同步，不用整页刷新。
 */
export const favoriteEntriesAtom = atom<FavoriteEntry[] | null>(null);

/** 「收藏」页面 Tab 是否打开（会话 Tab 栏里的页面式工作区，见 workspace-page-atoms）。 */
export const favoritesPageOpenAtom = atom((get) => get(workspacePageTabStateAtom).tabs.includes("favorites"));

/** 打开「收藏」页面 Tab（侧栏入口 / 命令面板共用）。 */
export const openFavoritesPageAtom = atom(null, (_get, set) => {
	set(openWorkspacePageAtom, "favorites");
});

/** 关闭「收藏」页面 Tab（页面子树卸载，下次打开回到列表顶部）。 */
export const closeFavoritesPageAtom = atom(null, (_get, set) => {
	set(closeWorkspacePageAtom, "favorites");
});
