/**
 * Web 端 Pi 会话安全等级菜单（与桌面 SecurityLevelMenu 能力对齐）。
 *
 * 数据来自 /api/state 的 security 投影（SecurityStore 单一数据源），切换经
 * POST /api/sessions/:id/security-level 由服务端校验并写策略快照；变更后服务端
 * 通过 /api/events 推送新快照，桌面端通过 security:config-changed 刷新，两端一致。
 *
 * 与 DSH 权限预设是两套机制：本组件只在 pi 会话（非 dsh/acp）由 WebHeader 渲染。
 */
import { Check, RotateCcw } from "lucide-react";
import type { WebSecurityState } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import { t } from "@/i18n";
import { permissionStrengthIcon, securityLevelIcon } from "../utils/permissionLevelIcon";

export function WebSecurityMenu(props: {
	sessionId: string;
	security: WebSecurityState;
	/** 外部禁用（如会话正在切换/保存）；菜单项在安全管理关闭时同样禁用 */
	disabled?: boolean;
	onChange: (levelId: string | null) => void;
}) {
	const { security } = props;
	const overrideId = security.sessionOverrides[props.sessionId];
	const effectiveId = overrideId ?? security.defaultLevelId;
	const effectiveLevel = security.levels.find((level) => level.id === effectiveId);
	const enabled = security.enabled;
	const levelName = effectiveLevel?.name ?? t("security.levelUnknown");
	// 与桌面一致：关闭时显示「关闭盾」，启用时按等级换专属盾
	const Icon = !enabled ? permissionStrengthIcon("relaxed") : securityLevelIcon(effectiveLevel ?? security.levels[0]);
	// 触发器只在外部禁用时不可点：安全管理关闭时仍允许打开菜单，否则用户看不到「去哪里开启」的提示
	const itemDisabled = props.disabled || !enabled;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:size-9" disabled={props.disabled} aria-label={t("security.menuTitle")} title={`${t("security.menuTitle")} · ${levelName}`}>
					<Icon className="size-4" aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				{/* 来源提示：让移动端用户一眼分清「跟随全局」还是「本会话覆盖」 */}
				<div className="border-b border-border/60 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">{!enabled ? t("security.menuDisabledHint") : overrideId ? t("security.sessionOverrideHint") : t("security.usingGlobalDefault")}</div>
				{security.levels.map((level) => {
					const selected = effectiveId === level.id;
					const ItemIcon = securityLevelIcon(level);
					return (
						<DropdownMenuItem key={level.id} disabled={itemDisabled} onSelect={() => props.onChange(level.id)} title={level.description} className="min-h-9 gap-2 px-2.5 py-1">
							<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
								<ItemIcon size={14} strokeWidth={2} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{level.name}</span>
							{selected ? <Check size={14} strokeWidth={2} className="shrink-0 text-primary" aria-hidden="true" /> : null}
						</DropdownMenuItem>
					);
				})}
				{enabled && overrideId ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem disabled={itemDisabled} onSelect={() => props.onChange(null)} className="min-h-9 gap-2 px-2.5 py-1">
							<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
								<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							</span>
							<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{t("security.followDefault")}</span>
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
