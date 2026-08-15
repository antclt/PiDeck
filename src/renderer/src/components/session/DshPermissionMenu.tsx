/**
 * DSH 会话权限预设选择器（输入框底栏安全位）
 *
 * DSH 后端不适用 PiDeck 内置安全等级（SecurityStore/安全门是 pi 链路的产物），
 * 走 DSH 自己的权限预设：read-only / workspace-write / danger-full-access
 * （sandbox 模式 + approval 策略的捆绑，与 dsh-web 的 PermissionSelect 同一组值）。
 *
 * - 读取：当前预设来自 host 会话事件折叠（permission/preset，经 runtime-state
 *   推送）；未启动/草稿会话回退到 settings permission.defaultPreset（新会话默认）。
 * - 切换：host 侧 slash 桥在 agent/pre-step 拦截 `/permission <name>` 并执行
 *   （命令事件 permission/preset + sandbox/mode + approval/policy 落会话日志，
 *   消息不进模型、不上时间线），随后 runtime-state 推送刷新底栏。
 * - danger-full-access 需确认（与 dsh-web 一致：完全访问是高风险预设）。
 */
import { useEffect, useState } from "react";
import { Check, Shield, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, upsertSessionAtom } from "../../atoms";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { CommandItem } from "../ui-shadcn/command";
import { CommandPickerPanel } from "../ui-shadcn/command-picker";
import { ConfirmDialog } from "../app/AppParts";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

/** DSH 权限预设（与 host 预设表一致；顺序即展示顺序）。 */
export const DSH_PERMISSION_PRESETS = [
	{ id: "read-only", labelKey: "dshPermission.readOnly", descriptionKey: "dshPermission.readOnlyDesc" },
	{ id: "workspace-write", labelKey: "dshPermission.workspaceWrite", descriptionKey: "dshPermission.workspaceWriteDesc" },
	{ id: "danger-full-access", labelKey: "dshPermission.fullAccess", descriptionKey: "dshPermission.fullAccessDesc" },
] as const;

const FULL_ACCESS = "danger-full-access";

function presetIcon(preset: string | undefined) {
	if (preset === "read-only") return ShieldOff;
	if (preset === "danger-full-access") return ShieldAlert;
	if (preset === "workspace-write") return ShieldCheck;
	return Shield;
}

function presetLabel(preset: string | undefined): string {
	if (!preset) return t("dshPermission.unknown");
	const known = DSH_PERMISSION_PRESETS.find((item) => item.id === preset);
	return known ? t(known.labelKey) : t("dshPermission.custom");
}

export function DshPermissionMenu(props: { sessionId: string; disabled?: boolean }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const upsertSession = useSetAtom(upsertSessionAtom);
	const [open, setOpen] = useState(false);
	const [confirmingFull, setConfirmingFull] = useState(false);
	const [sending, setSending] = useState(false);
	const [defaultPreset, setDefaultPreset] = useState<string | undefined>(undefined);

	// 当前生效预设：运行时折叠值（激活会话）> 会话记录预选（草稿期）> settings 默认
	const effectivePreset = runtime?.state?.permissionPreset ?? record?.permissionPreset ?? defaultPreset;

	useEffect(() => {
		let cancelled = false;
		void desktopApi.sessions.describeDshSettings().then((result) => {
			if (cancelled) return;
			const permission = result.namespaces.find((ns) => ns.ns === "permission");
			const value = permission?.value as { defaultPreset?: unknown } | undefined;
			if (value && typeof value.defaultPreset === "string") {
				setDefaultPreset(value.defaultPreset);
			}
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const hasRuntime = Boolean(runtime?.agentId);

	/** 切换：激活会话发 /permission <name>（host slash 桥执行，不进模型/不上时间线）；
	 *  草稿会话只写记录预选，激活时 applyPreferences 应用。两者都回写记录（源真相）。 */
	const switchPreset = async (preset: string) => {
		if (!hasRuntime) {
			// 草稿期预选：启动会话后生效
			try {
				const updated = await desktopApi.sessions.updateRecord(props.sessionId, { permissionPreset: preset });
				upsertSession(updated);
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
				return;
			}
			showNotice(t("dshPermission.presetPendingNotice", { name: presetLabel(preset) }), 3000);
			setOpen(false);
			return;
		}
		setSending(true);
		try {
			await desktopApi.sessions.sendPrompt({
				sessionId: props.sessionId,
				requestId: crypto.randomUUID(),
				message: `/permission ${preset}`,
			});
			// 记录同步为源真相：会话内切换也要持久化，重启/重新激活后保持一致
			const updated = await desktopApi.sessions.updateRecord(props.sessionId, { permissionPreset: preset });
			upsertSession(updated);
			showNotice(t("dshPermission.switchNotice", { name: presetLabel(preset) }), 3000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSending(false);
			setOpen(false);
		}
	};

	const pick = (preset: string) => {
		if (preset === FULL_ACCESS) {
			setOpen(false);
			setConfirmingFull(true);
			return;
		}
		void switchPreset(preset);
	};

	const Icon = presetIcon(effectivePreset);

	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="composer-bar-btn security dsh h-7 gap-1 rounded-md px-1.5 text-caption font-semibold text-foreground hover:bg-muted/60"
				disabled={props.disabled || sending}
				aria-label={t("dshPermission.menuTitle")}
				title={`${t("dshPermission.menuTitle")}: ${presetLabel(effectivePreset)}`}
				onClick={() => setOpen(true)}
			>
				<Icon size={15} strokeWidth={2} aria-hidden="true" />
				<span className="max-w-[9ch] truncate text-muted-foreground">{presetLabel(effectivePreset)}</span>
			</Button>
			<Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
				<DialogContent
					showCloseButton={false}
					className="dsh-permission-picker flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]"
				>
					<CommandPickerPanel
						title={t("dshPermission.menuTitle")}
						hint={t("dshPermission.menuHint")}
						searchPlaceholder={t("app.commandPickerSearch")}
						emptyLabel={t("app.commandPickerEmpty")}
						value={effectivePreset}
						onClose={() => setOpen(false)}
					>
						{DSH_PERMISSION_PRESETS.map((preset) => {
							const selected = effectivePreset === preset.id;
							const ItemIcon = presetIcon(preset.id);
							return (
								<CommandItem
									key={preset.id}
									value={preset.id}
									data-picker-value={preset.id}
									onSelect={() => pick(preset.id)}
									disabled={sending}
									className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1"
								>
									<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
										<ItemIcon size={14} aria-hidden="true" />
									</span>
									<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground" title={t(preset.descriptionKey)}>
										{t(preset.labelKey)}
									</span>
									<span className="shrink-0 text-micro text-muted-foreground/75">{t(preset.descriptionKey)}</span>
									{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
								</CommandItem>
							);
						})}
						{effectivePreset && !DSH_PERMISSION_PRESETS.some((item) => item.id === effectivePreset) && (
							<CommandItem
								value="custom"
								data-picker-value="custom"
								disabled
								className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1 opacity-60"
							>
								<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
									<Shield size={14} aria-hidden="true" />
								</span>
								<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">
									{t("dshPermission.custom")}
								</span>
							</CommandItem>
						)}
					</CommandPickerPanel>
				</DialogContent>
			</Dialog>
			{confirmingFull && (
				<ConfirmDialog
					title={t("dshPermission.fullAccessConfirmTitle")}
					message={t("dshPermission.fullAccessConfirmBody")}
					confirmLabel={t("dshPermission.fullAccessConfirmLabel")}
					onConfirm={() => {
						setConfirmingFull(false);
						void switchPreset(FULL_ACCESS);
					}}
					onCancel={() => setConfirmingFull(false)}
				/>
			)}
		</>
	);
}
