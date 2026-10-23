import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import type { SettingsSectionId, SettingsTabId } from "../../../atoms";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { Input } from "../../ui-shadcn/input";
import { buildSettingsSearchEntries } from "./settingsSearchEntries";
import { searchSettingsEntries, splitHighlightedTitle } from "./settingsSearch";

type SettingsSearchEntryItem = ReturnType<typeof buildSettingsSearchEntries>[number];

/**
 * 设置侧栏搜索框：输入即搜全部 tab 与设置项（中文 / 英文 / 拼音首字母），
 * 选中后由调用方跳到对应 tab 并滚到锚点。
 *
 * 为什么是「替换 tab 列表」而不是下拉浮层：侧栏只有 196px 宽，浮层会盖住内容区，
 * 而设置页本身没有别的操作用得上这块空间；直接占据同一列，用户看得到「搜到了多少条」，
 * 也不会因为浮层层级与弹窗滚动容器打架。
 *
 * 搜索态下 tab 列表直接卸载、换成结果列表（而不是用 `hidden` 隐藏）：Tailwind 的 `flex`
 * 会盖过 `hidden` 属性的 `display:none`，藏不住；Tabs 自身仍在，清空搜索后列表回来照旧。
 */
export function SettingsSearchBox(props: { entries: readonly SettingsSearchEntryItem[]; tabOrder: readonly SettingsTabId[]; onPick: (entry: SettingsSearchEntryItem) => void; children: ReactNode }) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const listRef = useRef<HTMLUListElement | null>(null);
	const searching = query.trim().length > 0;
	const hits = useMemo(() => searchSettingsEntries(props.entries, query, props.tabOrder), [props.entries, props.tabOrder, query]);

	// 查询变化后选中项回到第一条：否则「搜 A 时停在第 5 条，改成 B 还停在第 5 条」会误跳。
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	// 键盘上下移动时把选中项滚进视野（结果 > 一屏时才看得出来在动）。
	useEffect(() => {
		if (!searching) return;
		const list = listRef.current;
		const active = list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, searching]);

	const pick = (entry: SettingsSearchEntryItem) => {
		props.onPick(entry);
		setQuery("");
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			// 设置弹窗的 Esc 是「关闭弹窗」（全局既有行为，Radix 在 document 捕获阶段拦下，
			// 组件内 stopPropagation 挡不住），所以这里不抢 Esc，清空只走右侧的清除按钮。
			return;
		}
		if (!searching || hits.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((index) => (index + 1) % hits.length);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const hit = hits[activeIndex] ?? hits[0];
			if (hit) pick(hit.entry);
		}
	};

	return (
		<>
			<div className="shrink-0 px-2.5 pt-2.5">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input
						size="sm"
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={t("settings.searchPlaceholder")}
						aria-label={t("settings.searchPlaceholder")}
						title={t("settings.searchHint")}
						role="combobox"
						aria-expanded={searching}
						aria-controls={searching ? "settings-search-results" : undefined}
						aria-autocomplete="list"
						aria-activedescendant={searching && hits.length > 0 ? `settings-search-option-${activeIndex}` : undefined}
						className="pl-8 pr-7 text-control [&::-webkit-search-cancel-button]:hidden"
					/>
					{query ? (
						<button type="button" onClick={() => setQuery("")} aria-label={t("common.clear")} title={t("common.clear")} className="absolute right-2 top-1/2 grid size-4 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground">
							<X className="size-3.5" aria-hidden="true" />
						</button>
					) : null}
					{/* 常驻提示（最多两行）：这列只有 196px，两行是「说得清楚」与「不把 tab 列表顶下去」的折中；
					    完整说明（↑↓/Enter/Esc）留在 title 里。 */}
					<p className="mt-1 line-clamp-2 px-1 text-caption leading-snug text-muted-foreground">{t("settings.searchPinyinHint")}</p>
				</div>
			</div>
			{searching ? (
				<ul ref={listRef} id="settings-search-results" role="listbox" aria-label={t("settings.searchPlaceholder")} className="min-h-0 flex-1 overflow-y-auto p-1.5">
					{hits.length === 0 ? <li className="px-2 py-3 text-caption text-muted-foreground">{t("settings.searchNoResult")}</li> : null}
					{hits.map((hit, index) => (
						<li
							key={hit.entry.id}
							id={`settings-search-option-${index}`}
							data-index={index}
							role="option"
							aria-selected={index === activeIndex}
							onMouseEnter={() => setActiveIndex(index)}
							onClick={() => pick(hit.entry)}
							className={cn("flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5", index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground")}
						>
							<span className="block truncate text-control">
								{splitHighlightedTitle(hit.entry.title, hit.titleIndices).map((segment, segmentIndex) =>
									segment.hit ? (
										<mark key={segmentIndex} className="bg-transparent font-semibold text-primary">
											{segment.text}
										</mark>
									) : (
										<span key={segmentIndex}>{segment.text}</span>
									),
								)}
							</span>
							<span className="block truncate text-caption text-muted-foreground">{hit.entry.title === hit.entry.tabLabel ? null : hit.entry.tabLabel}</span>
						</li>
					))}
				</ul>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
			)}
		</>
	);
}
