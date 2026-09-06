import { Globe2, FolderOpen } from "lucide-react";
import { t } from "../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/ui-shadcn/select";

export type ResourceScope = "global" | "project";

/** 作用域选择器可展示的项目条目（PiDeck 已加载项目；Chat 项目除外）。 */
export type ResourceScopeProject = {
	id: string;
	name: string;
	kind?: string;
};

type ResourceScopeSelectorProps = {
	value: ResourceScope;
	/** PiDeck 当前加载的全部项目（下拉展示；Chat 项目不提供项目作用域）。 */
	projects: ResourceScopeProject[];
	/** 当前选中的项目 id（value === "project" 时生效）。 */
	selectedProjectId?: string;
	disabled?: boolean;
	onChange: (scope: ResourceScope, projectId?: string) => void;
};

/**
 * Shared scope selector for resources managed by the Pi configuration pane.
 * 展示「全局」+ PiDeck 全部已加载项目（非 Chat），可在任意项目间切换；
 * 父组件持有 value 与 selectedProjectId，切换资源 Tab 保持选择。
 */
export function ResourceScopeSelector({ value, projects, selectedProjectId, disabled = false, onChange }: ResourceScopeSelectorProps) {
	const availableProjects = projects.filter((item) => item.kind !== "chat");
	const selected = availableProjects.find((item) => item.id === selectedProjectId) ?? availableProjects[0];
	// 没有可用项目（全部为 Chat）时只能停留在全局
	const effectiveValue: ResourceScope = selected && value === "project" ? "project" : "global";
	const projectLabel = selected?.name?.trim() || t("config.resourceScope.projectFallback");

	return (
		<Select
			value={effectiveValue === "project" && selected ? selected.id : "global"}
			disabled={disabled || !selected}
			onValueChange={(next) => {
				if (next === "global") onChange("global");
				else {
					const target = availableProjects.find((item) => item.id === next);
					if (target) onChange("project", target.id);
				}
			}}
		>
			<SelectTrigger
				className="h-8 w-auto min-w-[9rem] max-w-full gap-1.5 px-2.5 text-control"
				aria-label={t("config.resourceScope.label")}
				title={disabled ? t("config.resourceScope.saveMcpFirst") : undefined}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{effectiveValue === "project" ? (
						<FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
					) : (
						<Globe2 className="size-3.5 shrink-0" aria-hidden="true" />
					)}
					<span className="truncate">{effectiveValue === "project" ? projectLabel : t("config.resourceScope.global")}</span>
				</span>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="global">
					<span className="flex items-center gap-1.5">
						<Globe2 className="size-3.5" aria-hidden="true" />
						{t("config.resourceScope.global")}
					</span>
				</SelectItem>
				{availableProjects.map((item) => (
					<SelectItem key={item.id} value={item.id}>
						<span className="flex min-w-0 items-center gap-1.5">
							<FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="truncate">{item.name}</span>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
