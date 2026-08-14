/**
 * DshModelsTable — DSH 配置页模型列表表格。
 *
 * 布局与 Pi 管理 ModelsTab 的模型表格同款：表头（ID / 名称 / 上下文 /
 * 最大 Token / 操作）+ 行内输入编辑 + 表头上方添加按钮 + 行尾删除。
 * 适用 llm-deepseek.models 与 llm-pi-ai.providers[*].models 两类数组。
 *
 * 表格行 key 用 index（Pi 管理同款处理）：id 是行内可编辑字段，
 * 用它做 key 会导致每次输入重建行、输入框失焦。
 */
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui-shadcn/table";
import { Plus, Trash2 } from "lucide-react";
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
	writable: boolean;
	/** 行内字段更新（field 为模型条目键名，如 id/name/contextWindow/maxTokens）。 */
	onUpdate: (index: number, field: string, value: unknown) => void;
	onAdd: () => void;
	onRemove: (index: number) => void;
}) {
	const { models, writable, onUpdate, onAdd, onRemove } = props;
	return (
		<div className="grid gap-1.5">
			<div className="flex items-center gap-2">
				<span className="text-caption font-semibold text-muted-foreground">{t("config.dsh.models")}</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 gap-1 px-1.5 text-micro text-muted-foreground"
					disabled={!writable}
					onClick={onAdd}
				>
					<Plus className="size-3" aria-hidden="true" />
					{t("config.dsh.addModel")}
				</Button>
			</div>
			<div className="config-model-table overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="w-48 min-w-0">{t("config.modelId")}</TableHead>
							<TableHead className="w-40 min-w-0">{t("config.modelDisplayName")}</TableHead>
							<TableHead className="w-28">{t("config.contextWindow")}</TableHead>
							<TableHead className="w-28">{t("config.maxTokens")}</TableHead>
							<TableHead className="w-16 text-right pr-3">{t("config.actions")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{models.map((model, index) => (
							<TableRow key={index} className="align-middle">
								<TableCell className="min-w-0 p-2 pl-3">
									<Input
										className="h-8 min-w-0 font-mono"
										placeholder="model-id"
										value={typeof model.id === "string" ? model.id : ""}
										disabled={!writable}
										onChange={(event) => onUpdate(index, "id", event.target.value)}
									/>
								</TableCell>
								<TableCell className="min-w-0 p-2">
									<Input
										className="h-8 min-w-0"
										placeholder={t("config.modelDisplayName")}
										value={typeof model.name === "string" ? model.name : ""}
										disabled={!writable}
										onChange={(event) => onUpdate(index, "name", event.target.value)}
									/>
								</TableCell>
								<TableCell className="p-2">
									<Input
										type="number"
										className="h-8 min-w-0"
										placeholder="1000000"
										value={typeof model.contextWindow === "number" ? String(model.contextWindow) : ""}
										disabled={!writable}
										onChange={(event) => {
											const next = event.target.value ? Number(event.target.value) : undefined;
											onUpdate(index, "contextWindow", Number.isFinite(next) ? next : undefined);
										}}
									/>
								</TableCell>
								<TableCell className="p-2">
									<Input
										type="number"
										className="h-8 min-w-0"
										placeholder="128000"
										value={typeof model.maxTokens === "number" ? String(model.maxTokens) : ""}
										disabled={!writable}
										onChange={(event) => {
											const next = event.target.value ? Number(event.target.value) : undefined;
											onUpdate(index, "maxTokens", Number.isFinite(next) ? next : undefined);
										}}
									/>
								</TableCell>
								<TableCell className="p-2">
									<div className="flex items-center justify-end gap-0.5">
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-7 text-muted-foreground hover:text-danger"
											title={t("config.dsh.removeModel")}
											aria-label={t("config.dsh.removeModel")}
											disabled={!writable}
											onClick={() => onRemove(index)}
										>
											<Trash2 className="size-3.5" aria-hidden="true" />
										</Button>
									</div>
								</TableCell>
							</TableRow>
						))}
						{models.length === 0 && (
							<TableRow>
								<TableCell colSpan={5} className="p-3 text-center text-micro text-muted-foreground">
									{t("config.dsh.modelsEmpty")}
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
