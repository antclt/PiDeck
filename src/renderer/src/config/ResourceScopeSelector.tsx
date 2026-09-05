import { Globe2, FolderOpen } from "lucide-react";
import { t } from "../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/ui-shadcn/select";

export type ResourceScope = "global" | "project";

type ResourceScopeSelectorProps = {
	value: ResourceScope;
	hasProject: boolean;
	projectName?: string;
	disabled?: boolean;
	onChange: (scope: ResourceScope) => void;
};

/**
 * Shared scope selector for resources managed by the Pi configuration pane.
 * The parent owns the value so switching resource tabs keeps the selected scope.
 */
export function ResourceScopeSelector({ value, hasProject, projectName, disabled = false, onChange }: ResourceScopeSelectorProps) {
	const effectiveValue: ResourceScope = hasProject && value === "project" ? "project" : "global";
	const projectLabel = projectName?.trim() || t("config.resourceScope.projectFallback");

	return (
		<Select
			value={effectiveValue}
			disabled={disabled}
			onValueChange={(next) => {
				if (next === "global" || (next === "project" && hasProject)) onChange(next);
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
				{hasProject ? (
					<SelectItem value="project">
						<span className="flex min-w-0 items-center gap-1.5">
							<FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="truncate">{projectLabel}</span>
						</span>
					</SelectItem>
				) : null}
			</SelectContent>
		</Select>
	);
}
