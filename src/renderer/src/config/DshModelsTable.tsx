/**
 * DshModelsTable — DSH 配置页模型列表（行式，对齐 dsh-web 的模型目录形态）。
 *
 * 每行一个模型：行上显示模型 ID 与显示名称（可编辑），右侧两个无文字操作
 * （展开容量 / 删除）；上下文窗口与最大输出 token 收在该行自己的折叠区里。
 * 顶部「添加模型」按钮；空列表显示「使用适配器默认模型」提示（继承态）。
 *
 * 行 key 用 index（id 是行内可编辑字段，用它做 key 会导致每次输入重建行、失焦）。
 */
import { useState } from "react";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { t } from "../i18n";

export type DshModelRow = {
	id?: unknown;
	name?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
};

export function ModelsTable(props: {
	/** 当前模型数组（现值，行内编辑由父级 draft 覆盖）。 */
	models: DshModelRow[];
	/** 适配器内置目录（只读展示；仅当 models 为空且未自定义时显示，对齐 dsh-web 的继承模型行）。 */
	catalog?: DshModelRow[];
	writable: boolean;
	/** 行内字段更新（field 为模型条目键名，如 id/name/contextWindow/maxTokens）。 */
	onUpdate: (index: number, field: string, value: unknown) => void;
	onAdd: () => void;
	onRemove: (index: number) => void;
	/** 模型 id 失焦：由编辑器按 pi-ai 目录补空容量，表格本身不打 IPC */
	onIdBlur?: (index: number, modelId: string) => void;
}) {
	const { models, writable, onUpdate, onAdd, onRemove } = props;
	/** 当前展开容量编辑的行（同时只展开一行）。 */
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	const inherited = models.length === 0 && (props.catalog?.length ?? 0) > 0;
	const shownModels = models.length > 0 ? models : (props.catalog ?? []);

	return (
		<div className="grid gap-1.5">
			<div className="flex items-center gap-2">
				<span className="text-caption font-semibold text-muted-foreground">{t("config.dsh.models")}</span>
				<span className="text-micro text-muted-foreground/70">
					{models.length === 0
						? t("config.dsh.modelsInherited")
						: t("config.dsh.modelsCustomized", { count: models.length })}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto h-6 gap-1 px-1.5 text-micro text-muted-foreground"
					disabled={!writable}
					onClick={onAdd}
				>
					<Plus className="size-3" aria-hidden="true" />
					{t("config.dsh.addModel")}
				</Button>
			</div>
			{shownModels.length === 0 ? (
				<div className="rounded-sm border border-dashed border-border-subtle px-3 py-2.5 text-micro text-muted-foreground">
					{t("config.dsh.modelsEmptyHint")}
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
					{shownModels.map((model, index) => {
						const isOpen = !inherited && expandedIndex === index;
						const id = typeof model.id === "string" ? model.id : "";
						const name = typeof model.name === "string" ? model.name : "";
						return (
							<div key={`${inherited ? "cat" : "row"}-${index}`} className="border-b border-border/40 last:border-b-0">
								<div className="flex items-center gap-2 px-2.5 py-1.5">
									{inherited ? (
										<span className="size-6 shrink-0" aria-hidden="true" />
									) : (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-6 shrink-0 text-muted-foreground"
											title={t("config.dsh.modelCapacity")}
											aria-label={t("config.dsh.modelCapacity")}
											disabled={!writable}
											onClick={() => setExpandedIndex(isOpen ? null : index)}
										>
											{isOpen ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
										</Button>
									)}
									{inherited ? (
										<span className="min-w-0 flex-1 truncate font-mono text-control text-foreground">{id}</span>
									) : (
										<Input
											className="h-7 min-w-0 flex-1 font-mono"
											placeholder="model-id"
											value={id}
											disabled={!writable}
											onChange={(event) => onUpdate(index, "id", event.target.value)}
											onBlur={(event) => props.onIdBlur?.(index, event.target.value)}
										/>
									)}
									{inherited ? (
										name ? <span className="min-w-0 flex-1 truncate text-control text-muted-foreground">{name}</span> : <span className="min-w-0 flex-1" aria-hidden="true" />
									) : (
										<Input
											className="h-7 min-w-0 flex-1"
											placeholder={t("config.modelDisplayName")}
											value={name}
											disabled={!writable}
											onChange={(event) => onUpdate(index, "name", event.target.value)}
										/>
									)}
									{!inherited && (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-7 shrink-0 text-muted-foreground hover:text-danger"
											title={t("config.dsh.removeModel")}
											aria-label={t("config.dsh.removeModel")}
											disabled={!writable}
											onClick={() => {
												// 删除展开行时收拢展开态
												if (expandedIndex === index) setExpandedIndex(null);
												onRemove(index);
											}}
										>
											<Trash2 className="size-3.5" aria-hidden="true" />
										</Button>
									)}
								</div>
								{isOpen && (
									<div className="grid gap-2.5 border-t border-border/40 px-3 py-2.5 sm:grid-cols-2">
										<label className="grid gap-1">
											<span className="text-micro text-muted-foreground">{t("config.contextWindow")}</span>
											<Input
												type="number"
												className="h-7"
												placeholder="1000000"
												value={typeof model.contextWindow === "number" ? String(model.contextWindow) : ""}
												disabled={!writable}
												onChange={(event) => {
													const next = event.target.value ? Number(event.target.value) : undefined;
													onUpdate(index, "contextWindow", Number.isFinite(next) ? next : undefined);
												}}
											/>
										</label>
										<label className="grid gap-1">
											<span className="text-micro text-muted-foreground">{t("config.maxTokens")}</span>
											<Input
												type="number"
												className="h-7"
												placeholder="128000"
												value={typeof model.maxTokens === "number" ? String(model.maxTokens) : ""}
												disabled={!writable}
												onChange={(event) => {
													const next = event.target.value ? Number(event.target.value) : undefined;
													onUpdate(index, "maxTokens", Number.isFinite(next) ? next : undefined);
												}}
											/>
										</label>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
