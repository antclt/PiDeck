import { Button } from "../components/ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/ui-shadcn/select";
import { Tabs, TabsList, TabsTrigger } from "../components/ui-shadcn/tabs";
import { useEffect, useState, type ReactNode } from "react";
import { Check, FileEdit, Pencil, ShoppingBag, Sparkles, ToggleLeft, ToggleRight, Trash2, X, Store, Globe } from "lucide-react";
import type {
	CreatePiSkillInput,
	PiSkillListResult,
	PiSkillLocation,
	PiSkillSummary,
	ProjectResourceOverrides,
} from "../../../shared/types";
import { t } from "../i18n";
import { SkillStoreTab } from "./SkillStoreTab";
import { SkillHubStorePanel } from "./SkillHubStorePanel";
import { Input } from "../components/ui-shadcn/input";
import { Textarea } from "../components/ui-shadcn/textarea";
import { Label } from "../components/ui-shadcn/label";
import type { ResourceScope } from "./ResourceScopeSelector";
import { globalSkillOverrideKey, isGlobalSkillSourceId } from "../../../shared/resourceIdentity";

export function SkillsTab(props: {
	scope: ResourceScope;
	scopeSelector?: ReactNode;
	projectOverrides: ProjectResourceOverrides;
	discoverySkills: Array<{
		id: string;
		name: string;
		path: string;
		dir: string;
		sourceId: string;
		sourceLabel: string;
		description: string;
		enabled: boolean;
		managed: boolean;
	}>;
	data: PiSkillListResult;
	loading: boolean;
	creating: boolean;
	newName: string;
	newDescription: string;
	newLocationId: PiSkillLocation["id"];
	onRefresh: () => void;
	onOpenRoot: () => void;
	onChangeNewName: (value: string) => void;
	onChangeNewDescription: (value: string) => void;
	onChangeNewLocation: (value: PiSkillLocation["id"]) => void;
	onCreate: () => void;
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void;
	onDelete: (skill: PiSkillSummary) => void;
	onEdit: (skill: PiSkillSummary) => void;
	onRename: (skill: PiSkillSummary, newName: string) => Promise<void>;
}) {
	const { data } = props;
	// Project scope shows both sources grouped by ownership; global scope only shows global skills.
	const visibleSkills = data.skills.filter((skill) => props.scope === "project" || skill.sourceId === "pi-global" || skill.sourceId === "agents-global");
	const projectSkills = visibleSkills.filter((skill) => skill.sourceId === "project-pi" || skill.sourceId === "project-agents");
	const globalSkills = visibleSkills.filter((skill) => skill.sourceId === "pi-global" || skill.sourceId === "agents-global");
	const disabledGlobalKeys = new Set(props.projectOverrides.disabledGlobalSkills);
	const availableLocations = data.locations.filter((location) =>
		props.scope === "project"
			? location.id === "project-pi" || location.id === "project-agents"
			: location.id === "pi-global" || location.id === "agents-global",
	);
	// 一级 tab：本地 / 商店
	const [skillTab, setSkillTab] = useState<"local" | "store">("local");
	// 二级 tab（商店内）：选择供应商
	const [storeSource, setStoreSource] = useState<"promptchat" | "skillhub">("skillhub");
	useEffect(() => {
		if (props.scope === "project" && skillTab === "store") setSkillTab("local");
	}, [props.scope, skillTab]);
	const canCreate = props.newName.trim() && props.newDescription.trim();
	// 新建技能的位置只影响保存目标，不应把其他目录已有的技能从列表中隐藏。
	const selectedLocation =
		availableLocations.find((location) => location.id === props.newLocationId) ??
		availableLocations[0];
	return (
		<div className="skills-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				{/* Scope stays in the page header while Local/Store content changes below. */}
				<Tabs
					value={skillTab}
					onValueChange={(v) => { if (v === "local" || v === "store") setSkillTab(v); }}
					className="min-w-0 flex-1 gap-0"
				>
					<TabsList className="w-full">
						<TabsTrigger value="local" onClick={() => props.onRefresh()}>
							{t("config.nav.skills")}
						</TabsTrigger>
						<TabsTrigger value="store" disabled={props.scope === "project"}>
							<ShoppingBag size={14} strokeWidth={1.8} />
							{t("config.promptStoreTab")}
						</TabsTrigger>
					</TabsList>
				</Tabs>
				<div className="shrink-0">{props.scopeSelector}</div>
			</div>

			{skillTab === "store" ? (
				<div className="skills-store-content">
					{/* 二级 tab：供应商切换（shadcn Tabs，紧凑变体） */}
					<Tabs
						value={storeSource}
						onValueChange={(v) => { if (v === "skillhub" || v === "promptchat") setStoreSource(v); }}
						className="gap-0"
					>
						<TabsList className="w-full">
							<TabsTrigger value="skillhub" className="px-3 py-1 text-xs">
								<Store size={14} strokeWidth={1.8} />
								{t("config.tabs.skillHub")}
							</TabsTrigger>
							<TabsTrigger value="promptchat" className="px-3 py-1 text-xs">
								<Globe size={14} strokeWidth={1.8} />
								Prompt.chat
							</TabsTrigger>
						</TabsList>
					</Tabs>
					{storeSource === "skillhub" ? (
						<SkillHubStorePanel />
					) : (
						<SkillStoreTab
							onImported={props.onRefresh}
							locationId={props.newLocationId}
						/>
					)}
				</div>
			) : (
				<>
					<div className="mb-3 flex items-center justify-between gap-3">
				<div>
					<span className="font-mono text-xs tabular-nums text-text-tertiary">
						{t("config.count.skills", { count: visibleSkills.length })}
					</span>
					<small className="skills-restart-hint">
						{t("config.restartHint")}
					</small>
				</div>
				<div className="skills-toolbar-actions flex items-center gap-1.5">
					{/* 与扩展页/设置页统一为 sm 控件高度 */}
					<Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
						{t("common.refresh")}
					</Button>
					<Button variant="secondary" size="sm" onClick={props.onOpenRoot}>
						{t("config.openFolder")}
					</Button>
				</div>
			</div>

			<section className="config-create-card">
				<strong>{t("config.createSkill")}</strong>
				<div className="config-create-grid">
					<Label className="config-create-label">
						<span>{t("config.name")}</span>
						<Input
							value={props.newName}
							placeholder={t("config.skillNamePlaceholder")}
							onChange={(event) => props.onChangeNewName(event.target.value)}
						/>
					</Label>
					<Label className="config-create-label">
						<span>{t("config.location")}</span>
						<Select
							value={props.newLocationId}
							onValueChange={(v) => {
								// 只接受已知位置 id，避免外部字符串注入；仅改变保存目标，不立即创建文件。
								if (v === "pi-global" || v === "agents-global" || v === "project-pi" || v === "project-agents") {
									props.onChangeNewLocation(v);
								}
							}}
						>
							{/* 只显示相对路径（label 形如 ~/.pi/agent/skills）：绝对路径长且无增益，
								窄列会溢出框边界；单行 + truncate 超长省略。 */}
							<SelectTrigger className="w-full">
								<span className="min-w-0 flex-1 truncate text-left">
									{selectedLocation?.label ?? t("config.chooseFolder")}
								</span>
							</SelectTrigger>
							<SelectContent>
								{availableLocations.map((location) => (
									<SelectItem key={location.id} value={location.id}>
										<span className="min-w-0 flex-1 truncate text-left">{location.label}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Label>
				</div>
				<Label className="config-create-label">
					<span>{t("config.description")}</span>
					<Textarea
						value={props.newDescription}
						placeholder={t("config.skillUseWhenPlaceholder")}
						onChange={(event) => props.onChangeNewDescription(event.target.value)}
						className="min-h-[72px] resize-y"
					/>
				</Label>
				<Button size="sm" variant="default"
					className="justify-self-start"
					onClick={props.onCreate}
					disabled={!canCreate || props.creating}
				>
					{props.creating ? t("config.creatingSkill") : t("config.addSkill")}
				</Button>
			</section>

			<div className="overflow-x-auto rounded-lg border border-border-subtle bg-bg-panel">
				{visibleSkills.length === 0 ? (
					<div className="py-12 text-center text-control text-text-tertiary">{t("config.emptySkills")}</div>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead className="w-56">{t("config.name")}</TableHead>
								{/* 描述列固定 40% 占比：table-fixed 忽略 min-width，窗口拉小时
								    无 width 的列会被压到接近 0（描述竖条）；给百分比宽度后
								    各列按比例压缩，描述列任何窗口下都保持可读宽度 */}
								<TableHead className="w-2/5">{t("config.description")}</TableHead>
								<TableHead className="w-44">{t("config.extensionPath")}</TableHead>
								<TableHead className="w-36 text-right">{t("config.actions")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{props.scope === "project" && projectSkills.length > 0 ? (
								<TableRow>
									<TableCell colSpan={4} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
										{t("config.resourceGroup.project")}
									</TableCell>
								</TableRow>
							) : null}
							{props.scope === "project" && projectSkills.map((skill) => (
								<SkillTableRow
									key={skill.id}
									skill={skill}
									effectiveEnabled={skill.enabled}
									inherited={false}
									onToggle={props.onToggle}
									onDelete={props.onDelete}
									onEdit={props.onEdit}
									onRename={props.onRename}
								/>
							))}
							{props.scope === "project" &&
								props.discoverySkills
									.filter((item) => isProjectDiscoverySource(item.sourceId))
									.map((item) => (
										<DiscoveredSkillRow key={item.id} item={item} />
									))}
							{props.scope === "project" && globalSkills.length > 0 ? (
								<TableRow>
									<TableCell colSpan={4} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
										{t("config.resourceGroup.global")}
									</TableCell>
								</TableRow>
							) : null}
							{globalSkills.map((skill) => {
								const inherited = props.scope === "project";
								const disabledHere = isGlobalSkillSourceId(skill.sourceId)
									? disabledGlobalKeys.has(globalSkillOverrideKey(skill.sourceId, skill.name))
									: false;
								return (
									<SkillTableRow
										key={skill.id}
										skill={skill}
										effectiveEnabled={skill.enabled && !disabledHere}
										inherited={inherited}
										onToggle={props.onToggle}
										onDelete={props.onDelete}
										onEdit={props.onEdit}
										onRename={props.onRename}
									/>
								);
							})}
							{props.scope === "project" &&
								props.discoverySkills
									.filter((item) => !isProjectDiscoverySource(item.sourceId))
									.map((item) => (
										<DiscoveredSkillRow key={item.id} item={item} />
									))}
						</TableBody>
					</Table>
				)}
			</div>
		</>
			)}
		</div>
	);
}

function DiscoveredSkillRow(props: {
	item: {
		id: string;
		name: string;
		path: string;
		sourceId: string;
		sourceLabel: string;
		description: string;
		enabled: boolean;
		managed: boolean;
	};
}) {
	const { item } = props;
	return (
		<TableRow>
			<TableCell className="min-w-0">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" />
						<strong className="truncate text-control font-medium text-foreground">{item.name}</strong>
						<span className="skill-state" title={t("config.resourceManagedHint")}>
							{t("config.resourceManaged")}
						</span>
						<span className={`skill-state ${item.enabled ? "enabled" : "disabled"}`}>
							{item.enabled ? t("common.enabled") : t("common.disabled")}
						</span>
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{item.sourceLabel}</span>
				</div>
			</TableCell>
			<TableCell className="w-2/5 whitespace-normal break-words text-caption leading-relaxed text-muted-foreground" title={item.description}>
				<span className="block line-clamp-3">{item.description}</span>
			</TableCell>
			<TableCell className="truncate font-mono text-caption text-muted-foreground" title={item.path}>
				{item.path}
			</TableCell>
			<TableCell className="text-right" />
		</TableRow>
	);
}

/** Discovery rows split into the project group vs the inherited global group. */
function isProjectDiscoverySource(sourceId: string): boolean {
	return sourceId === "package-project" || sourceId === "settings-project" || sourceId === "ancestor-agents";
}

function SkillTableRow(props: {
	skill: PiSkillSummary;
	effectiveEnabled: boolean;
	inherited: boolean;
	onToggle: (skill: PiSkillSummary, enabled: boolean) => void;
	onDelete: (skill: PiSkillSummary) => void;
	onEdit: (skill: PiSkillSummary) => void;
	onRename: (skill: PiSkillSummary, newName: string) => Promise<void>;
}) {
	const { skill, effectiveEnabled, inherited } = props;
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(skill.name);
	const [renameBusy, setRenameBusy] = useState(false);

	useEffect(() => {
		// A row can remain mounted while the shared scope changes. Never leave a global
		// rename form usable after that row becomes a read-only inherited resource.
		if (inherited && renaming) {
			setRenaming(false);
			setRenameValue(skill.name);
		}
	}, [inherited, renaming, skill.name]);

	const handleRename = async () => {
		if (inherited) {
			setRenaming(false);
			return;
		}
		if (renameBusy || !renameValue.trim() || renameValue.trim() === skill.name) {
			setRenaming(false);
			return;
		}
		setRenameBusy(true);
		try {
			await props.onRename(skill, renameValue.trim());
			setRenaming(false);
		} finally {
			setRenameBusy(false);
		}
	};

	return (
		<TableRow>
			<TableCell className="min-w-0">
				{renaming && !inherited ? (
					<div className="flex items-center gap-1">
						<Input
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); if (e.key === "Escape") setRenaming(false); }}
							autoFocus
							disabled={renameBusy}
						/>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={handleRename} disabled={renameBusy} title={t("common.confirm")}>
							<Check size={14} strokeWidth={2} />
						</Button>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setRenaming(false)} disabled={renameBusy} title={t("common.cancel")}>
							<X size={14} strokeWidth={2} />
						</Button>
					</div>
				) : (
					<div className="flex min-w-0 flex-col gap-0.5">
						<div className="flex min-w-0 items-center gap-2">
							<Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-text-tertiary" />
							<strong className="truncate text-control font-medium text-foreground">{skill.name}</strong>
							<div className="skill-badges">
								<span className={`skill-state ${effectiveEnabled ? "enabled" : "disabled"}`}>
									{effectiveEnabled ? t("common.enabled") : t("common.disabled")}
								</span>
								{!skill.valid && <span className="skill-state invalid">{t("config.needsFix")}</span>}
							</div>
						</div>
						<span className="truncate font-mono text-caption text-muted-foreground">{skill.sourceLabel}</span>
						{skill.warnings.length > 0 && (
							<div className="flex flex-col gap-0.5">
								{skill.warnings.map((warning) => (
									<span key={warning} className="truncate text-caption text-destructive">{warning}</span>
								))}
							</div>
						)}
					</div>
				)}
			</TableCell>
			{/* 描述太长时截断为 3 行（title 悬浮可看全文），避免长描述把整行撑得
			    很高；描述列 w-2/5 占比 + 3 行截断，窗口拉小也不挤压成竖条。
			    line-clamp 会改 display 为 -webkit-box，必须包一层 span 而不能直接放 td 上。 */}
			<TableCell className="w-2/5 whitespace-normal break-words text-caption leading-relaxed text-muted-foreground" title={skill.description}>
				<span className="block line-clamp-3">{skill.description || t("config.skillDescriptionMissing")}</span>
			</TableCell>
			<TableCell className="truncate font-mono text-caption text-muted-foreground" title={skill.path}>
				{skill.path}
			</TableCell>
			<TableCell className="text-right">
				<div className="flex justify-end gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						className={`size-7${effectiveEnabled ? " text-accent" : ""}`}
						disabled={inherited && !skill.enabled}
						onClick={() => props.onToggle(skill, !effectiveEnabled)}
						title={effectiveEnabled ? t("common.disable") : t("common.enabled")}
					>
						{effectiveEnabled
							? <ToggleRight size={18} strokeWidth={1.8} />
							: <ToggleLeft size={18} strokeWidth={1.8} />}
					</Button>
					{!inherited ? (
						<>
							<Button variant="ghost" size="icon-sm" className="size-7"
								onClick={() => props.onEdit(skill)}
								title={t("common.edit")}
							>
								<Pencil size={14} strokeWidth={1.8} />
							</Button>
							<Button variant="ghost" size="icon-sm" className="size-7"
								onClick={() => { setRenaming(true); setRenameValue(skill.name); }}
								title={t("common.rename")}
							>
								<FileEdit size={14} strokeWidth={1.8} />
							</Button>
							<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
								onClick={() => props.onDelete(skill)}
								title={t("common.delete")}
							>
								<Trash2 size={14} strokeWidth={1.8} />
							</Button>
						</>
					) : null}
				</div>
			</TableCell>
		</TableRow>
	);
}

export type { CreatePiSkillInput };
