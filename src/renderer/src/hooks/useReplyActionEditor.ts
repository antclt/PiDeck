import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_REPLY_ACTION_RULES } from "../../../shared/replyActions";
import type { ReplyActionRule } from "../../../shared/types/replyActions";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { useReplyActions } from "./useReplyActions";

/**
 * 管理弹框的规则草稿与写盘编排。
 *
 * 与 useQuickMessageEditor 的差异：规则是结构化对象（text + triggers），不存在
 * 「打字合并 400ms」——text 是受控 Input，triggers 是离散点击，任何改动都立即落盘，
 * 界面永远显示文件真实内容（主进程清洗回包），没有可丢失的中间态。
 *
 * 结构性操作（增删/排序/恢复默认/补充内置）走整份保存；主进程负责清洗
 * （坏 trigger 丢弃、按 text 去重、截断到上限）。
 */
export function useReplyActionEditor() {
	const { items, defaults, defaultsAvailable, filePath, loading, error, save, refresh, openFile } = useReplyActions();
	const [merging, setMerging] = useState(false);
	const itemsRef = useRef(items);
	const defaultsRef = useRef({ items: defaults, available: defaultsAvailable });
	itemsRef.current = items;
	defaultsRef.current = { items: defaults, available: defaultsAvailable };

	/** 整份保存；失败走 notice（与快捷消息一致的反馈渠道）。 */
	const commit = useCallback(
		async (rules: ReplyActionRule[]): Promise<boolean> => {
			const ok = await save(rules);
			if (!ok) showNotice(t("settings.replyActionsSaveFailed"));
			return ok;
		},
		[save],
	);

	const setRuleText = useCallback(
		(index: number, text: string) => {
			const current = itemsRef.current;
			if (index < 0 || index >= current.length) return;
			// 文案只影响这一条；triggers 原样保留（主进程清洗仍会校验 triggers 非空）
			void commit(current.map((rule, i) => (i === index ? { ...rule, text } : rule)));
		},
		[commit],
	);

	const setRuleTriggers = useCallback(
		(index: number, triggers: ReplyActionRule["triggers"]) => {
			const current = itemsRef.current;
			if (index < 0 || index >= current.length) return;
			// triggers 清空成无效规则的中间态由 UI 阻止（至少保留一个），这里不做兜底删除
			void commit(current.map((rule, i) => (i === index ? { ...rule, triggers } : rule)));
		},
		[commit],
	);

	const addRule = useCallback(() => {
		const current = itemsRef.current;
		if (current.length >= MAX_REPLY_ACTION_RULES) return;
		// 新规则默认 onStop：最常见的「回复结束后出现」，用户改文案即可用
		void commit([...current, { text: "", triggers: [{ kind: "onStop" }] }]);
	}, [commit]);

	const removeRule = useCallback(
		(index: number) => {
			const current = itemsRef.current;
			if (index < 0 || index >= current.length) return;
			void commit(current.filter((_, i) => i !== index));
		},
		[commit],
	);

	const moveRule = useCallback(
		(index: number, direction: -1 | 1) => {
			const current = itemsRef.current;
			const target = index + direction;
			if (index < 0 || index >= current.length || target < 0 || target >= current.length) return;
			const next = [...current];
			[next[index], next[target]] = [next[target], next[index]];
			void commit(next);
		},
		[commit],
	);

	const reorderRules = useCallback(
		(from: number, to: number) => {
			const current = itemsRef.current;
			if (from === to || from < 0 || from >= current.length || to < 0 || to >= current.length) return;
			const next = [...current];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			void commit(next);
		},
		[commit],
	);

	/** 重新读取内置清单，只追加个人规则缺少文案的条目，保留已有顺序（受上限约束）。 */
	const mergeDefaults = useCallback(async () => {
		setMerging(true);
		try {
			const snapshot = await refresh();
			const current = itemsRef.current;
			if (!snapshot) return;
			const known = new Set(current.map((rule) => rule.text));
			const additions = defaultsRef.current.items.filter((rule) => !known.has(rule.text));
			if (additions.length === 0) {
				showNotice(t("settings.replyActionsNothingToAdd"));
				return;
			}
			// 快照 items 是磁盘最新内容，additions 是缺项：直接以快照为基线追加
			await commit([...snapshot.items, ...additions].slice(0, MAX_REPLY_ACTION_RULES));
		} finally {
			setMerging(false);
		}
	}, [commit, refresh]);

	/** 用内置清单整体替换个人规则。 */
	const resetDefaults = useCallback(async () => {
		setMerging(true);
		try {
			await commit(defaultsRef.current.items);
		} finally {
			setMerging(false);
		}
	}, [commit]);

	return {
		rules: items,
		defaults,
		defaultsAvailable,
		filePath,
		loading,
		error,
		merging,
		atLimit: items.length >= MAX_REPLY_ACTION_RULES,
		addRule,
		removeRule,
		moveRule,
		reorderRules,
		setRuleText,
		setRuleTriggers,
		mergeDefaults,
		resetDefaults,
		refresh,
		openFile,
	};
}
