import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import type { AgentBackend, DshSkillView, PiSkillSummary } from "../../../../shared/types";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui-shadcn/command";
import { PickerDialog } from "./ComposerComponents";

/** 技能选择面板展示用的统一条目（pi 项目技能 / DSH 部署技能）。 */
type SkillItem = {
	/** 调用名（不含前导斜杠；pi/DshSkillView.name 已是 kebab-case）。 */
	name: string;
	description: string;
	whenToUse?: string;
	/** false = 用户专用技能（disable-model-invocation）：仅用户可调用。 */
	userOnly?: boolean;
};

export function ComposerSkillPicker(props: {
	/** 按会话后端选数据源：pi = 项目资源技能，dsh = DSH 部署技能目录。 */
	backend: AgentBackend;
	/** pi 后端需要项目 ID 才能读取项目技能。 */
	projectId?: string;
	/** DSH 后端需要已激活的 Agent（skill.list 走 runtime wire）。 */
	agentId?: string;
	onClose: () => void;
	onPick: (name: string) => void;
}) {
	const [items, setItems] = useState<SkillItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// 数据源随后端分叉：pi 走 projectResources.list（本地技能文件系统），
	// DSH 走 listDshSkills（G7 skill.list 只读目录）；两者都要求会话上下文
	// （pi 需要 projectId，DSH 需要 agentId 已激活），缺上下文时显示提示而非报错。
	useEffect(() => {
		if (props.backend === "pi" && !props.projectId) {
			setLoading(false);
			return;
		}
		if (props.backend === "dsh" && !props.agentId) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		const load = props.backend === "pi"
			? desktopApi.projectResources.list(props.projectId as string).then((result) =>
				result.skills
					.filter((skill) => skill.enabled)
					.map((skill: PiSkillSummary) => ({
						name: skill.name,
						description: skill.description,
					})),
			)
			: desktopApi.sessions.listDshSkills(props.agentId as string).then((list: DshSkillView[]) =>
				list.map((skill) => ({
					name: skill.name,
					description: skill.description,
					whenToUse: skill.whenToUse,
					userOnly: !skill.modelInvocable,
				})),
			);
		void load.then((next) => {
			if (!cancelled) setItems(next);
		}).catch((reason) => {
			if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
		}).finally(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [props.backend, props.projectId, props.agentId]);

	// 缺上下文（pi 无项目 / DSH 草稿未启动）：给定位原因，不让用户误以为技能为空。
	const blockedByProject = props.backend === "pi" && !props.projectId;
	const blockedByAgent = props.backend === "dsh" && !props.agentId;

	return (
		<PickerDialog
			title={t("app.skillPickerTitle")}
			hint={t("app.skillPickerHint")}
			onClose={props.onClose}
			className="skill-picker"
		>
			<Command>
				<CommandInput placeholder={t("app.skillPickerSearchPlaceholder")} autoFocus />
				<CommandList>
					{/* cmdk 的 Empty 只在列表有数据且过滤后无匹配时才有意义；
					    loading/出错/缺上下文等非列表态由下方自定义块承担，避免双提示。 */}
					{!loading && !error && !blockedByProject && !blockedByAgent && (
						<CommandEmpty>{t("app.skillPickerSearchEmpty")}</CommandEmpty>
					)}
					{loading ? (
						<div className="flex items-center justify-center gap-2 py-6 text-caption text-muted-foreground">
							<Loader2 size={14} className="animate-spin" aria-hidden="true" />
							{t("app.skillPickerLoading")}
						</div>
					) : error ? (
						<div className="py-6 text-center text-caption text-muted-foreground">{t("app.skillPickerLoadFailed")}</div>
					) : blockedByProject ? (
						<div className="py-6 text-center text-caption text-muted-foreground">{t("app.skillPickerNoProject")}</div>
					) : blockedByAgent ? (
						<div className="py-6 text-center text-caption text-muted-foreground">{t("app.skillPickerNoAgent")}</div>
					) : items.length === 0 ? (
						<div className="py-6 text-center text-caption text-muted-foreground">{t("app.skillPickerEmpty")}</div>
					) : (
						items.map((skill) => (
							<CommandItem
								key={skill.name}
								value={`/${skill.name}`}
								keywords={[skill.name, skill.description, skill.whenToUse ?? ""]}
								onSelect={() => props.onPick(skill.name)}
							>
								<Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
								<span className="picker-palette-label">/{skill.name}</span>
								{skill.userOnly && (
									<span className="shrink-0 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro font-medium text-amber-600 dark:text-amber-400">
										{t("dshTools.skillUserOnly")}
									</span>
								)}
								<span className="picker-palette-desc">{skill.description}</span>
							</CommandItem>
						))
					)}
				</CommandList>
			</Command>
		</PickerDialog>
	);
}