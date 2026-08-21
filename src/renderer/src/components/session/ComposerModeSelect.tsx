import { useCallback, useEffect, useMemo, useState } from "react";
import { ImageIcon, ListChecks, Target, Wrench } from "lucide-react";
import type { AgentBackend, ComposerAgentMode } from "../../../../shared/types";
import { desktopApi } from "../../desktopApi";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";

type ModeOption = {
	value: ComposerAgentMode;
	labelKey: TranslationKey;
	descriptionKey: TranslationKey;
};

const MODE_OPTIONS: ModeOption[] = [
	{
		value: "normal",
		labelKey: "app.composerModeNormal",
		descriptionKey: "app.composerModeNormalDesc",
	},
	{
		value: "plan",
		labelKey: "app.composerModePlan",
		descriptionKey: "app.composerModePlanDesc",
	},
	{
		value: "goal",
		labelKey: "app.composerModeGoal",
		descriptionKey: "app.composerModeGoalDesc",
	},
	{
		value: "imagegen",
		labelKey: "app.composerModeImagegen",
		descriptionKey: "app.composerModeImagegenDesc",
	},
];

function ModeGlyph(props: { mode: ComposerAgentMode; size?: number }) {
	const size = props.size ?? 15;
	if (props.mode === "plan") return <ListChecks size={size} strokeWidth={2} aria-hidden="true" />;
	if (props.mode === "imagegen") return <ImageIcon size={size} strokeWidth={2} aria-hidden="true" />;
	if (props.mode === "goal") return <Target size={size} strokeWidth={2} aria-hidden="true" />;
	return <Wrench size={size} strokeWidth={2} aria-hidden="true" />;
}

function parseComposerAgentMode(value: string): ComposerAgentMode | null {
	if (value === "normal" || value === "plan" || value === "goal" || value === "imagegen") {
		return value;
	}
	return null;
}

/**
 * 底栏工作模式：四个选项用 shadcn Select 就地下拉，不再开 CommandPicker 弹层。
 * 计划/目标是否出现由内置扩展开关决定（DSH 恒可用）；生图在 DSH 隐藏。
 */
export function ComposerModeSelect(props: {
	value: ComposerAgentMode;
	backend?: AgentBackend;
	disabled?: boolean;
	/** 会话已有生图消息时锁定生图模式，避免误切回会走 LLM 发送。 */
	imageGenLocked?: boolean;
	onChange: (mode: ComposerAgentMode) => void;
}) {
	const isDsh = props.backend === "dsh";
	const [planModeAvailable, setPlanModeAvailable] = useState(true);
	const [goalModeAvailable, setGoalModeAvailable] = useState(true);

	const refreshAvailability = useCallback(async () => {
		if (isDsh) {
			setPlanModeAvailable(true);
			setGoalModeAvailable(true);
			return;
		}
		try {
			const result = await desktopApi.extensions.list();
			const plan = result.extensions.find((extension) => extension.source === "pi-deck-plan-mode.ts");
			const goal = result.extensions.find((extension) => extension.source === "pi-deck-goal-mode.ts");
			const planAvailable = plan?.enabled !== false;
			const goalAvailable = goal?.enabled !== false;
			setPlanModeAvailable(planAvailable);
			setGoalModeAvailable(goalAvailable);
			if (props.imageGenLocked) return;
			if (!planAvailable && props.value === "plan") props.onChange("normal");
			if (!goalAvailable && props.value === "goal") props.onChange("normal");
		} catch {
			setPlanModeAvailable(false);
			setGoalModeAvailable(false);
			if (props.imageGenLocked) return;
			if (props.value === "plan" || props.value === "goal") props.onChange("normal");
		}
	}, [isDsh, props.imageGenLocked, props.onChange, props.value]);

	useEffect(() => {
		void refreshAvailability();
	}, [refreshAvailability]);

	const items = useMemo(() => {
		if (props.imageGenLocked) {
			return MODE_OPTIONS.filter((item) => item.value === "imagegen");
		}
		return MODE_OPTIONS.filter((item) => {
			if (item.value === "plan") return planModeAvailable;
			if (item.value === "goal") return goalModeAvailable;
			if (item.value === "imagegen") return !isDsh;
			return true;
		});
	}, [goalModeAvailable, isDsh, planModeAvailable, props.imageGenLocked]);

	const current = MODE_OPTIONS.find((item) => item.value === props.value) ?? MODE_OPTIONS[0];
	const isSpecialMode = props.value !== "normal";

	return (
		<Select
			value={props.value}
			disabled={props.disabled || props.imageGenLocked}
			onOpenChange={(open) => {
				if (open) void refreshAvailability();
			}}
			onValueChange={(value) => {
				const next = parseComposerAgentMode(value);
				if (!next || next === props.value) return;
				props.onChange(next);
			}}
		>
			<SelectTrigger
				size="sm"
				className={cn(
					"composer-bar-btn mode h-7 max-w-[9.5rem] gap-1 rounded-md border-transparent px-1.5 text-control font-semibold text-foreground hover:bg-muted/60",
					isSpecialMode && "hover:bg-transparent",
				)}
				title={t(current.descriptionKey)}
				aria-label={t("app.composerModeTitle")}
			>
				<SelectValue>
					<span className="inline-flex min-w-0 items-center gap-1">
						<ModeGlyph mode={props.value} />
						<span
							className={cn(
								"min-w-0 truncate",
								isSpecialMode
									? "text-control font-normal"
									: "text-micro italic font-normal text-muted-foreground",
							)}
						>
							{t(current.labelKey)}
						</span>
					</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" className="min-w-[12rem]">
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value} title={t(item.descriptionKey)}>
						<ModeGlyph mode={item.value} size={14} />
						{t(item.labelKey)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
