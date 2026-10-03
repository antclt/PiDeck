/**
 * 设置页「自定义主题」区块：主题目录卡片列表（内置示例 + 用户文件）、应用/停用、
 * JSON 编辑器（保存前主进程同源校验）、AI 开发指南落盘入口。
 * 应用动作只写草稿（themeSkin=custom + customTheme 快照），预览/持久化由壳层接管；
 * 编辑保存直接落盘主题目录（与设置草稿无关，改坏可随时再编辑）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getI18nLocale, t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import type { AppSettings } from "../../../../../shared/types";
import { CUSTOM_THEME_TEMPLATE, serializeCustomThemePackage, type CustomThemeListItem } from "../../../../../shared/customThemes";
import { Button } from "../../ui-shadcn/button";
import { Badge } from "../../ui-shadcn/badge";
import { Textarea } from "../../ui-shadcn/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { AlertTriangle, BookOpenText, Check, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type CustomThemeSectionProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
};

/** 单个色板小样：底色块 + 主色条 + 文字点，token 缺席时回落当前主题变量（视觉不空洞） */
function SchemeSwatch({ tokens, dark }: { tokens: Record<string, string>; dark: boolean }) {
	return (
		<div className="flex h-8 w-[76px] shrink-0 items-center gap-1 rounded-sm border border-border px-1.5" style={{ background: tokens["bg-app"] ?? (dark ? "#16181a" : "#f5f5f4") }} aria-hidden="true" title={dark ? t("settings.themeDark") : t("settings.themeLight")}>
			<span className="h-4 w-4 rounded-[2px] border border-black/10" style={{ background: tokens["bg-panel"] ?? (dark ? "#1e2124" : "#ffffff") }} />
			<span className="h-2 w-2 rounded-full" style={{ background: tokens["accent"] ?? "var(--color-accent)" }} />
			<span className="h-1.5 w-5 rounded-full" style={{ background: tokens["text-primary"] ?? (dark ? "#ececec" : "#2b2b2b") }} />
		</div>
	);
}

/** 编辑器弹窗状态：title 仅展示；raw 为当前编辑文本 */
type EditorState = { title: string; raw: string };

export function CustomThemeSection({ draft, updateDraft }: CustomThemeSectionProps) {
	const [dir, setDir] = useState("");
	const [themes, setThemes] = useState<CustomThemeListItem[]>([]);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	// 删除二段确认： armed=待再次点击确认的条目 id；超时自动解除，避免误删
	const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
	const disarmTimer = useRef<number | undefined>(undefined);

	const refresh = useCallback(async (): Promise<CustomThemeListItem[]> => {
		const result = await desktopApi.customThemes.list();
		setDir(result.dir);
		setThemes(result.themes);
		return result.themes;
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		return () => {
			if (disarmTimer.current !== undefined) window.clearTimeout(disarmTimer.current);
		};
	}, []);

	// 当前生效的自定义主题 id（themeSkin 非 custom 时快照不生效，不标「使用中」）
	const appliedId = draft.themeSkin === "custom" ? draft.customTheme?.id : undefined;

	const applyTheme = (item: CustomThemeListItem) => {
		if (item.parseError) return;
		// 只写草稿：设置弹窗预览立即生效，保存后由 App 的 useAppAppearance 持久化接管
		updateDraft({ themeSkin: "custom", customTheme: { id: item.id, name: item.name, light: item.tokens.light, dark: item.tokens.dark } });
		toast(t("settings.customThemesAppliedToast"));
	};

	const unapplyTheme = () => {
		// 停用只清快照；themeSkin 保持 custom（回落 customThemeOverrides + 基础色板）
		updateDraft({ customTheme: undefined });
	};

	const openEditor = (title: string, raw: string) => {
		setErrors([]);
		setEditor({ title, raw });
	};

	const handleNew = () => openEditor(t("settings.customThemesNew"), serializeCustomThemePackage(CUSTOM_THEME_TEMPLATE));

	const handleEdit = async (item: CustomThemeListItem) => {
		const raw = await desktopApi.customThemes.read(item.id);
		if (raw === null) {
			toast.error(t("settings.customThemesReadFailed"));
			void refresh();
			return;
		}
		openEditor(t("settings.customThemesEditTitle", { name: item.name }), raw);
	};

	const handleSave = async () => {
		if (!editor) return;
		setSaving(true);
		try {
			const result = await desktopApi.customThemes.save(editor.raw);
			if (!result.ok) {
				setErrors(result.errors);
				return;
			}
			setErrors([]);
			setEditor(null);
			const list = await refresh();
			// 正在使用的主题被就地修改：同步刷新草稿快照，避免「文件改了界面没变」
			if (appliedId === result.id) {
				const updated = list.find((entry) => entry.id === result.id && !entry.parseError);
				if (updated) updateDraft({ themeSkin: "custom", customTheme: { id: updated.id, name: updated.name, light: updated.tokens.light, dark: updated.tokens.dark } });
			}
			toast(t("settings.customThemesSavedToast", { id: result.id }));
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (item: CustomThemeListItem) => {
		// 内置示例不可删（常量随包分发，不在磁盘上）
		if (item.source !== "user") return;
		if (armedDeleteId !== item.id) {
			// 第一段：进入待确认；3 秒无动作自动解除
			setArmedDeleteId(item.id);
			if (disarmTimer.current !== undefined) window.clearTimeout(disarmTimer.current);
			disarmTimer.current = window.setTimeout(() => setArmedDeleteId(null), 3000);
			return;
		}
		setArmedDeleteId(null);
		await desktopApi.customThemes.remove(item.id);
		await refresh();
		toast(t("settings.customThemesDeletedToast", { id: item.id }));
	};

	const handleGuide = async () => {
		try {
			const path = await desktopApi.customThemes.writeGuide(getI18nLocale() === "en-US" ? "en-US" : "zh-CN");
			toast(t("settings.customThemesGuideToast", { path }));
		} catch {
			toast.error(t("settings.customThemesGuideFailed"));
		}
	};

	const handleCopyDir = async () => {
		if (!dir) return;
		try {
			await navigator.clipboard.writeText(dir);
			toast(t("settings.customThemesDirCopiedToast"));
		} catch {
			toast.error(dir);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			{/* 工具栏：新建 / 复制示例 / AI 指南 / 复制目录（目录路径即「丢给 AI」的关键信息） */}
			<div className="flex flex-wrap items-center gap-1.5">
				<Button variant="outline" size="sm" onClick={handleNew}>
					<Plus className="size-3.5" />
					{t("settings.customThemesNew")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					title={t("settings.customThemesCopyDemoHint")}
					onClick={async () => {
						const demo = themes.find((item) => item.source === "builtin");
						if (!demo) return;
						const raw = await desktopApi.customThemes.read(demo.id);
						if (raw === null) return;
						// 复制为新主题：改 id/name 避免覆盖内置示例（内置不可写）
						const copy = raw.replace(/"id":\s*"[^"]+"/, '"id": "my-berry-theme"').replace(/"name":\s*"[^"]+"/, '"name": "我的莓果主题"');
						openEditor(t("settings.customThemesCopyDemo"), copy);
					}}
				>
					<Copy className="size-3.5" />
					{t("settings.customThemesCopyDemo")}
				</Button>
				<Button variant="outline" size="sm" onClick={handleGuide} title={t("settings.customThemesGuideHint")}>
					<BookOpenText className="size-3.5" />
					{t("settings.customThemesGuide")}
				</Button>
				<Button variant="ghost" size="sm" onClick={handleCopyDir} title={dir} disabled={!dir}>
					{t("settings.customThemesCopyDir")}
				</Button>
			</div>
			{dir ? <div className="font-mono text-[11px] leading-relaxed text-text-faint break-all">{dir}</div> : null}

			{/* 主题卡片列表 */}
			<div className="flex flex-col gap-1.5">
				{themes.length === 0 ? <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t("settings.customThemesEmpty")}</div> : null}
				{themes.map((item) => {
					const applied = appliedId === item.id && !item.parseError;
					return (
						<div key={`${item.source}:${item.id}`} className={cn("flex items-center gap-2 rounded-md border px-2.5 py-2", applied ? "border-[var(--color-accent)]" : "border-border", item.parseError ? "border-[var(--color-danger)]/60" : "")}>
							{item.parseError ? (
								// 解析失败条目：展示首个错误 + 文件名，供定位坏文件
								<div className="flex min-w-0 flex-1 items-start gap-2">
									<AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
									<div className="min-w-0">
										<div className="truncate font-mono text-xs">{item.id}.json</div>
										<div className="truncate text-[11px] text-text-tertiary">{item.parseError[0]}</div>
									</div>
								</div>
							) : (
								<>
									<SchemeSwatch tokens={item.tokens.light} dark={false} />
									<SchemeSwatch tokens={item.tokens.dark} dark />
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span className="truncate text-sm">{item.name}</span>
											<Badge variant="secondary" className="shrink-0">
												{item.source === "builtin" ? t("settings.customThemesBuiltin") : t("settings.customThemesUser")}
											</Badge>
											{applied ? (
												<Badge className="shrink-0 gap-1">
													<Check className="size-3" />
													{t("settings.customThemesApplied")}
												</Badge>
											) : null}
										</div>
										<div className="truncate text-[11px] text-text-tertiary">{[item.version, item.author, item.description].filter(Boolean).join(" · ")}</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										{applied ? (
											<Button variant="ghost" size="sm" onClick={unapplyTheme}>
												{t("settings.customThemesUnapply")}
											</Button>
										) : (
											<Button variant="outline" size="sm" onClick={() => applyTheme(item)}>
												{t("settings.customThemesApply")}
											</Button>
										)}
										<Button variant="ghost" size="sm" onClick={() => void handleEdit(item)} title={t("settings.customThemesEdit")}>
											<Pencil className="size-3.5" />
										</Button>
										{item.source === "user" ? (
											<Button variant="ghost" size="sm" className={cn(armedDeleteId === item.id ? "text-[var(--color-danger)]" : "text-muted-foreground")} onClick={() => void handleDelete(item)} title={armedDeleteId === item.id ? t("settings.customThemesDeleteConfirmAgain") : t("settings.customThemesDelete")}>
												<Trash2 className="size-3.5" />
											</Button>
										) : null}
									</div>
								</>
							)}
						</div>
					);
				})}
			</div>

			{/* JSON 编辑器：保存走主进程校验（同目录扫描同源），错误就地列出 */}
			<Dialog open={editor !== null} onOpenChange={(open) => (open ? undefined : setEditor(null))}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{editor?.title ?? ""}</DialogTitle>
					</DialogHeader>
					<Textarea value={editor?.raw ?? ""} onChange={(event) => setEditor((prev) => (prev ? { ...prev, raw: event.target.value } : prev))} className="min-h-[320px] font-mono text-xs leading-relaxed" spellCheck={false} aria-label={t("settings.customThemesEditorTitle")} />
					{errors.length > 0 ? (
						<div className="max-h-28 overflow-y-auto rounded-md border border-[var(--color-danger)]/50 bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
							{errors.map((error, index) => (
								// eslint-disable-next-line react/no-array-index-key -- 错误清单为静态展示，无重排
								<div key={index}>{error}</div>
							))}
						</div>
					) : null}
					<DialogFooter>
						<Button variant="ghost" size="sm" onClick={() => setEditor(null)}>
							{t("common.cancel")}
						</Button>
						<Button size="sm" disabled={saving} onClick={() => void handleSave()}>
							{t("settings.customThemesSave")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
