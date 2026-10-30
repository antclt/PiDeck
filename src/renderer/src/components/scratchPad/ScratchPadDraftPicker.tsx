import { useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "../ui-shadcn/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { t } from "../../i18n";
import type { DraftMeta } from "../../../../shared/types";

/**
 * 草稿选择器：草稿数量不可控，普通 Select 在几十份时变成不可搜索的长滚动。
 * 这里用可搜索下拉 + 作用域分组：项目作用域同时列出「本项目」与「全局」，全局作用域只有全局组。
 */
export function ScratchPadDraftPicker(props: { drafts: DraftMeta[]; currentDraftPath: string | null; onSelect: (draftPath: string) => void }) {
	const [open, setOpen] = useState(false);
	const current = props.drafts.find((draft) => draft.path === props.currentDraftPath);
	const projectDrafts = props.drafts.filter((draft) => draft.scope === "project");
	const globalDrafts = props.drafts.filter((draft) => draft.scope === "global");

	const displayName = (draft: DraftMeta) => (draft.scope === "global" ? `${t("scratchPad.groupGlobal")} · ${draft.name}` : draft.name);

	const renderItems = (items: DraftMeta[]) =>
		items.map((draft) => (
			<CommandItem
				key={draft.path}
				value={draft.path}
				keywords={[draft.name]}
				onSelect={(value) => {
					props.onSelect(value);
					setOpen(false);
				}}
			>
				<Check className={draft.path === props.currentDraftPath ? "size-4 shrink-0 opacity-100" : "size-4 shrink-0 opacity-0"} aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate" title={draft.name}>
					{draft.name}
				</span>
			</CommandItem>
		));

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					role="combobox"
					aria-expanded={open}
					aria-label={t("scratchPad.showFileList")}
					className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-bg-input px-3 text-control whitespace-nowrap outline-none transition-[color,background-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
				>
					<span className="min-w-0 flex-1 truncate text-left">{current ? displayName(current) : t("scratchPad.selectDraftPlaceholder")}</span>
					<ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
				<Command
					// 只按草稿名匹配：value 是绝对路径，默认过滤会被目录名（projects/global）污染。
					filter={(_value, search, keywords) => ((keywords ?? []).join(" ").toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
				>
					<div className="border-b p-1.5">
						<div className="flex h-8 items-center gap-2 rounded-md border bg-transparent px-2.5">
							<Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
							<CommandPrimitive.Input placeholder={t("scratchPad.searchDrafts")} className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
						</div>
					</div>
					<CommandList>
						<CommandEmpty>{t("scratchPad.noDraftsMatch")}</CommandEmpty>
						{projectDrafts.length > 0 ? <CommandGroup heading={t("scratchPad.groupProject")}>{renderItems(projectDrafts)}</CommandGroup> : null}
						{globalDrafts.length > 0 ? <CommandGroup heading={t("scratchPad.groupGlobal")}>{renderItems(globalDrafts)}</CommandGroup> : null}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
