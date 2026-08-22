import { useCallback, useEffect, useState } from "react";
import type { AgentBackend, ComposerAgentMode } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

export const MODE_ORDER: ComposerAgentMode[] = ["normal", "goal", "plan", "imagegen"];

/**
 * 计算「+」菜单里可显示的模式（纯函数，供 hook 与单测共用，单一来源）：
 * - imagegen 仅 pi（DSH 会话隐藏）；
 * - plan/goal 由对应内置扩展开关决定（DSH 恒可用）；
 * - imageGenLocked 时锁定为仅 imagegen（会话已有生图消息，避免误切回 LLM 发送）。
 */
export function computeVisibleModes(options: {
	isDsh: boolean;
	imageGenLocked?: boolean;
	planModeAvailable: boolean;
	goalModeAvailable: boolean;
}): ComposerAgentMode[] {
	const available = MODE_ORDER.filter((mode) => {
		if (mode === "imagegen") return !options.isDsh;
		if (mode === "plan") return options.planModeAvailable;
		if (mode === "goal") return options.goalModeAvailable;
		return true;
	});
	return options.imageGenLocked
		? available.filter((mode) => mode === "imagegen")
		: available;
}

/**
 * 「+」菜单里的模式可用性（原 ComposerModeSelect 底栏 chip 的逻辑迁到这里）：
 * - DSH 恒可用 plan/goal；imagegen 仅 pi（DSH 会话隐藏）。
 * - pi 的 plan/goal 由内置扩展 pi-deck-plan-mode / pi-deck-goal-mode 的启用状态决定；
 *   扩展被关时若当前正处该模式，强制回退到普通模式（与旧 chip 行为对齐）。
 * - imageGenLocked：会话已有生图消息时锁定生图模式——只允许 imagegen，防止误切回 LLM 发送。
 */
export function useComposerModeAvailability(props: {
	backend?: AgentBackend;
	imageGenLocked?: boolean;
	value: ComposerAgentMode;
	disabled?: boolean;
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
			setPlanModeAvailable(plan?.enabled !== false);
			setGoalModeAvailable(goal?.enabled !== false);
		} catch {
			// 扩展列表读取失败时保守处理：两个模式都按不可用对待，避免用户选了却无扩展响应。
			setPlanModeAvailable(false);
			setGoalModeAvailable(false);
		}
	}, [isDsh]);

	// 打开菜单时刷新（扩展开关可能刚在设置页改过）。不可用且当前正在用则强制回退，
	// 这属于模式状态流转的边界：不在这里回退，用户会卡在一个扩展已删的模式上。
	useEffect(() => {
		if (props.imageGenLocked) return;
		if (!planModeAvailable && props.value === "plan") props.onChange("normal");
		if (!goalModeAvailable && props.value === "goal") props.onChange("normal");
	}, [goalModeAvailable, planModeAvailable, props.imageGenLocked, props.onChange, props.value]);

	const visibleModes = computeVisibleModes({
		isDsh,
		imageGenLocked: props.imageGenLocked,
		planModeAvailable,
		goalModeAvailable,
	});

	return { visibleModes, refreshAvailability };
}