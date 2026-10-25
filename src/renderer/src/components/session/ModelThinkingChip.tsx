import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { useShortcutBindings } from "../../hooks/useShortcutBindings";
import { formatAccelerator } from "../../../../shared/shortcuts";
import { Button } from "../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { Slider } from "../ui-shadcn/slider";
import { clampThinkingLevelToAllowed } from "../../utils/thinkingDisplay";
import { THINKING_LEVELS, type ThinkingPickerLevel } from "./sessionPickerOptions";

/** 紧凑的模型/思考组合：模型直接打开完整选择器，思考保留独立的就地入口。 */
export function ModelThinkingChip(props: { modelLabel: string; modelPendingTo?: string; modelPendingTitle?: string; disabled?: boolean; onPickModel: () => void; thinkingControl: ReactNode }) {
	const modelValue = props.modelPendingTo ? `${props.modelLabel} → ${props.modelPendingTo}` : props.modelLabel;
	return (
		<div className="composer-bar-btn model-thinking inline-flex h-7 min-w-0 max-w-[52ch] items-center rounded-md text-control font-medium">
			<Button variant="ghost" size="sm" className="h-7 min-w-0 rounded-md px-2 text-control font-medium text-foreground hover:bg-muted/60" disabled={props.disabled} onClick={props.onPickModel} title={props.modelPendingTitle ?? t("app.modelPickerTitle")} aria-label={t("app.modelPickerTitle")}>
				<span className="min-w-0 truncate">{modelValue}</span>
			</Button>
			<span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
				·
			</span>
			{props.thinkingControl}
		</div>
	);
}

/** 轨道上的装饰星尘：固定坐标（非随机，避免每次渲染跳动），纯视觉 aria-hidden。
 *  强度渐变本体在 tailwind.css 的 .thinking-intensity-slider（success→info 语义 token）。 */
const TRACK_DOTS = [
	{ left: "8%", top: "30%", size: 3 },
	{ left: "22%", top: "58%", size: 2 },
	{ left: "38%", top: "26%", size: 2 },
	{ left: "52%", top: "62%", size: 3 },
	{ left: "66%", top: "34%", size: 2 },
	{ left: "80%", top: "56%", size: 3 },
] as const;

/**
 * 思考强度选择：ZCode 同款渐变强度条（beUI 口径：shadcn Slider 原语 + 语义 token）。
 * 离散档位吸附（step=1）而非连续值——模型只认 off…max 的枚举；刻度标签行兼作点击入口，
 * 方向键在滑条上原生平移档位。壳从 DropdownMenu 换成 Popover：Radix Menu 会劫持
 * 方向键（typeahead/导航），滑条键盘操作会被吞；Popover 不拦截，滑条键盘可达。
 */
export function ThinkingLevelDropdown(props: { current?: string; levels?: ThinkingPickerLevel[]; open: boolean; onOpenChange: (open: boolean) => void; disabled?: boolean; onPick: (level: string) => void }) {
	// undefined 表示能力尚未知，沿用旧版全量回退；[] 则是后端明确表示不支持。
	const levels = props.levels ?? THINKING_LEVELS;
	const effectiveLevel = levels.some((level) => level.value === props.current) ? props.current : clampThinkingLevelToAllowed(props.current, levels);
	const currentIndex = Math.max(
		0,
		levels.findIndex((level) => level.value === (effectiveLevel ?? props.current)),
	);
	const currentLevel = levels[currentIndex];
	const thinkingText = currentLevel?.labelKey ? t(currentLevel.labelKey) : (currentLevel?.label ?? effectiveLevel ?? props.current ?? t("app.think"));
	const { bindings: shortcutTable, platform } = useShortcutBindings();
	const cycleThinkingShortcut = useMemo(() => (shortcutTable ? formatAccelerator(shortcutTable.cycleThinking, platform) : undefined), [shortcutTable, platform]);
	// 拖拽预览值：外部 current 变化（快捷键 Ctrl+T 循环、模型切换 clamp、RPC 应用回执）时同步；
	// 头行/说明实时跟随预览档位，触发按钮保持「已应用」档位。
	// ref 是提交逻辑的真值源（松手时读到拖拽终点，SSR 单渲染内同样即时可见），
	// state 只驱动渲染（thumb/标签高亮）。lastCommittedRef 记录已提交档位：
	// 提交到应用之间是异步窗口，快速二次松手/回车靠它跳过重复 RPC。
	const draftIndexRef = useRef(currentIndex);
	const lastCommittedRef = useRef(currentIndex);
	const [draftIndexState, setDraftIndexState] = useState(currentIndex);
	useEffect(() => {
		draftIndexRef.current = currentIndex;
		lastCommittedRef.current = currentIndex;
		setDraftIndexState(currentIndex);
	}, [currentIndex]);
	const setDraftIndex = (value: number) => {
		draftIndexRef.current = value;
		setDraftIndexState(value);
	};
	const draftIndex = draftIndexState;
	const previewLevel = levels[draftIndex] ?? currentLevel;
	/** 提交预览档位：与已提交档位相同则跳过（thumb 原地点击/重复松手不发无意义 RPC）。 */
	const commitDraft = () => {
		const level = levels[draftIndexRef.current];
		if (level && draftIndexRef.current !== lastCommittedRef.current) {
			lastCommittedRef.current = draftIndexRef.current;
			props.onPick(level.value);
		}
	};
	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="h-7 min-w-0 shrink-0 rounded-md px-2 text-control font-medium text-muted-foreground hover:bg-muted/60" disabled={props.disabled} title={t("app.thinkingPickerTitle")} aria-label={t("app.thinkingPickerTitle")}>
					<span className="max-w-[16ch] truncate">{thinkingText}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" side="top" className="w-72 min-w-64 max-w-[min(320px,calc(100vw-24px))] p-3" aria-label={t("app.thinkingPickerTitle")}>
				{levels.length === 0 ? (
					<div className="px-1 py-2 text-caption text-muted-foreground">{t("app.thinkingPickerUnsupported")}</div>
				) : (
					<div className="flex min-w-0 flex-col gap-2.5">
						{/* 头行：强度标签 + 预览档位（拖拽实时跟随）+ 全局快捷键提示（跟随用户自定义键位） */}
						<div className="flex min-w-0 items-center gap-2">
							<span className="shrink-0 text-caption text-muted-foreground">{t("thinking.pickerIntensityLabel")}</span>
							<span className="min-w-0 truncate text-control font-semibold text-foreground">{previewLevel?.labelKey ? t(previewLevel.labelKey) : (previewLevel?.label ?? previewLevel?.value)}</span>
							{cycleThinkingShortcut ? (
								<kbd className="ml-auto shrink-0 rounded-sm border border-border-subtle bg-bg-muted px-1.5 py-0.5 font-mono text-micro leading-none text-muted-foreground" aria-hidden="true">
									{cycleThinkingShortcut}
								</kbd>
							) : null}
						</div>
						{/* 渐变强度条：拖拽只更新本地预览（draftIndex），松手/回车才提交 onPick——
						    onValueChange 在拖拽中逐档触发，直接接 onPick 会在第一档应用后
						    经 onApplied→onClose 弹层立刻关闭（拖不动）；同值提交跳过 RPC。
						    键盘方向键只预览，Enter 提交（Radix onValueCommit 每次按键都发，不能用）。 */}
						<Slider
							value={[draftIndex]}
							min={0}
							max={levels.length - 1}
							step={1}
							disabled={props.disabled}
							onValueChange={(values) => setDraftIndex(values[0] ?? currentIndex)}
							onPointerUp={() => commitDraft()}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									commitDraft();
								}
							}}
							aria-label={t("thinking.pickerIntensityAria")}
							className="thinking-intensity-slider [&_[data-slot=slider-track]]:h-2"
						>
							{/* 星尘装饰：绝对定位在轨道容器上，pointer-events-none 不吃拖拽 */}
							<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2">
								{TRACK_DOTS.map((dot) => (
									<span key={dot.left} className="absolute rounded-full bg-white/45" style={{ left: dot.left, top: `calc(${dot.top} - 50%)`, width: dot.size, height: dot.size }} />
								))}
							</div>
						</Slider>
						{/* 档位标签行：兼作点击入口（直接提交原始 id），预览档位高亮 */}
						<div className="flex min-w-0 items-start justify-between gap-1">
							{levels.map((level, index) => (
								<Button
									key={level.value}
									type="button"
									variant="ghost"
									data-tick-value={level.value}
									className={`h-auto min-w-0 max-w-full truncate rounded-sm px-0.5 py-0 text-micro leading-4 font-normal shadow-none transition-colors hover:bg-transparent ${index === draftIndex ? "font-semibold text-foreground" : "text-muted-foreground"}`}
									disabled={props.disabled}
									title={level.descriptionKey ? t(level.descriptionKey) : level.description}
									onClick={() => {
										setDraftIndex(index);
										props.onPick(level.value);
									}}
								>
									{level.labelKey ? t(level.labelKey) : (level.label ?? level.value)}
								</Button>
							))}
						</div>
						{/* 预览档位说明：拖拽实时跟随，保留原菜单 title 的可读位置 */}
						{previewLevel ? <p className="m-0 truncate text-caption text-muted-foreground">{previewLevel.descriptionKey ? t(previewLevel.descriptionKey) : previewLevel.description}</p> : null}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
