import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AddFavoriteInput, FavoriteEntry } from "../../../shared/types";
import { favoriteEntriesAtom } from "../atoms/favorites-atoms";
import { collectFavoritedMessageKeys, findMessageFavorite } from "../components/favorites/favoriteIdentity";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/** 首次读取去重：时间线、右键菜单钩子、收藏页可能同时挂载，只发一次 favorites:list。 */
let loadInFlight: Promise<FavoriteEntry[]> | null = null;

function loadFavoritesOnce(): Promise<FavoriteEntry[]> {
	loadInFlight ??= desktopApi.favorites.list().finally(() => {
		loadInFlight = null;
	});
	return loadInFlight;
}

export type FavoriteActions = {
	/** null = 还没读到主进程列表（首次挂载时异步拉取）。 */
	entries: FavoriteEntry[] | null;
	/** 已收藏的「整条消息」身份键集合（sessionId::messageId），供入口显示/切换已收藏态。 */
	favoritedMessageKeys: ReadonlySet<string>;
	refresh: () => Promise<void>;
	/** 收藏成功返回条目（入口用于判断是否要收起浮层），失败返回 null 并 toast。 */
	addFavorite: (input: AddFavoriteInput) => Promise<FavoriteEntry | null>;
	removeFavorite: (favoriteId: string) => Promise<boolean>;
	/**
	 * 整条消息收藏开关：同一条消息（sessionId + messageId）已有收藏则删除，否则新增。
	 * 没有 messageId（live 流式正文）无法去重，退化为「只新增」。
	 */
	toggleMessageFavorite: (input: AddFavoriteInput) => Promise<boolean>;
};

/**
 * 收藏域的读写入口（页面 / 右键菜单 / 划选浮层 / 回合动作条共用）。
 *
 * 数据源单一：列表存在 favoriteEntriesAtom，写入成功后原地更新 atom，任何入口收藏/取消收藏都能
 * 让已打开的收藏页与入口的「已收藏」状态立即同步；首次挂载才向主进程拉一次。
 * 失败一律 toast，不抛出——收藏是旁路能力，不能打断复制/提问等主流程。
 */
export function useFavorites(): FavoriteActions {
	const [entries, setEntries] = useAtom(favoriteEntriesAtom);
	// 切换动作要读「最新收藏表」，但回调本身必须保持引用稳定（TurnRow 自定义 memo 不比较回调）。
	const entriesRef = useRef<FavoriteEntry[] | null>(null);
	entriesRef.current = entries;

	const refresh = useCallback(async () => {
		try {
			setEntries(await loadFavoritesOnce());
		} catch {
			// 读失败保留已有列表：收藏页宁可显示上次内容，也不要清空成「没有收藏」。
		}
	}, [setEntries]);

	useEffect(() => {
		if (entries === null) void refresh();
	}, [entries, refresh]);

	const favoritedMessageKeys = useMemo(() => collectFavoritedMessageKeys(entries ?? []), [entries]);

	const addFavorite = useCallback(
		async (input: AddFavoriteInput): Promise<FavoriteEntry | null> => {
			try {
				const entry = await desktopApi.favorites.add(input);
				setEntries((current) => [entry, ...(current ?? [])]);
				showNotice(t("favorites.saved"), 1200);
				return entry;
			} catch {
				showNotice(t("favorites.saveFailed"), 2400, "error");
				return null;
			}
		},
		[setEntries],
	);

	const removeFavorite = useCallback(
		async (favoriteId: string): Promise<boolean> => {
			try {
				const removed = await desktopApi.favorites.remove(favoriteId);
				if (removed) setEntries((current) => (current ?? []).filter((entry) => entry.id !== favoriteId));
				showNotice(removed ? t("favorites.removed") : t("favorites.removeFailed"), removed ? 1200 : 2400, removed ? undefined : "error");
				return removed;
			} catch {
				showNotice(t("favorites.removeFailed"), 2400, "error");
				return false;
			}
		},
		[setEntries],
	);

	const toggleMessageFavorite = useCallback(
		async (input: AddFavoriteInput): Promise<boolean> => {
			const existing = findMessageFavorite(entriesRef.current ?? [], input.sessionId ?? null, input.messageId ?? null);
			if (existing) return removeFavorite(existing.id);
			return (await addFavorite(input)) !== null;
		},
		[addFavorite, removeFavorite],
	);

	return { entries, favoritedMessageKeys, refresh, addFavorite, removeFavorite, toggleMessageFavorite };
}
