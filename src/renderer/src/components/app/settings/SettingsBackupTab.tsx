import { useCallback, useEffect, useState } from "react";
import { t, type TranslationKey } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import {
	BackupDetailDialog,
	RestoreDialog,
	formatBytes,
	formatReason,
	formatTime,
} from "./SettingsBackupDialogs";
import type {
	ConfigBackupDetail,
	ConfigBackupMeta,
} from "../../../../../shared/types/backup";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";

/**
 * 配置备份 tab：列出所有配置备份（pi 配置文件 + pideck 设置），
 * 支持立即备份、查看（脱敏）、恢复（单个/全部文件）、删除。
 *
 * 自动备份由主进程触发（首次使用 / 版本升级 / 配置保存，防抖合并），
 * 本组件只负责展示与手动操作，不感知触发逻辑。
 */
export function BackupTab() {
	const [backups, setBackups] = useState<ConfigBackupMeta[] | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("");
	const [error, setError] = useState("");
	const [confirm, setConfirm] = useState<{
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);
	const [detail, setDetail] = useState<ConfigBackupDetail | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	/** 恢复选择弹窗目标：非 null 时弹窗打开（默认全选，可勾选单个文件）。 */
	const [restoreTarget, setRestoreTarget] = useState<ConfigBackupDetail | null>(null);

	const refresh = useCallback(async () => {
		const result = await window.piDesktop.configBackups.list();
		if (result.ok) {
			setBackups(result.backups);
			setError("");
		} else {
			setError(result.error);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** 统一动作执行：busyKey 标识列表行 loading（默认 "action" = 顶部按钮）。 */
	const runAction = async (
		action: () => Promise<{ ok: boolean; error?: string }>,
		successKey: TranslationKey,
		busyKey: string = "action",
	) => {
		setBusy(busyKey);
		setFeedback("");
		try {
			const result = await action();
			if (result.ok) {
				setFeedback(t(successKey));
				await refresh();
			} else {
				setError(result.error ?? t("common.error"));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const doCreate = () => {
		void runAction(
			() => window.piDesktop.configBackups.create("manual"),
			"settings.backup.createSuccess",
		);
	};

	/** 打开恢复选择弹窗：先读取脱敏详情拿到文件清单，再让用户勾选。 */
	const openRestoreDialog = async (backup: ConfigBackupMeta) => {
		setBusy(backup.id);
		try {
			const result = await window.piDesktop.configBackups.read(backup.id);
			if (result) {
				setRestoreTarget(result);
			} else {
				setError(t("settings.backup.readFailed"));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const confirmDelete = (backup: ConfigBackupMeta) => {
		setConfirm({
			title: t("settings.backup.deleteTitle"),
			message: t("settings.backup.deleteConfirm", {
				time: formatTime(backup.createdAt),
			}),
			onConfirm: () => {
				setConfirm(null);
				void runAction(
					() => window.piDesktop.configBackups.delete(backup.id),
					"settings.backup.deleteSuccess",
					backup.id,
				);
			},
		});
	};

	const openDetail = async (backup: ConfigBackupMeta) => {
		setBusy(backup.id);
		try {
			const result = await window.piDesktop.configBackups.read(backup.id);
			if (result) {
				setDetail(result);
				setDetailOpen(true);
			} else {
				setError(t("settings.backup.readFailed"));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	const isLoading = backups === null;

	return (
		<>
			{confirm && (
				<ConfirmDialog
					title={confirm.title}
					message={confirm.message}
					danger
					onConfirm={confirm.onConfirm}
					onCancel={() => setConfirm(null)}
				/>
			)}
			<BackupDetailDialog detail={detail} open={detailOpen} onOpenChange={setDetailOpen} />
			<RestoreDialog
				detail={restoreTarget}
				open={restoreTarget !== null}
				restoring={busy !== null && busy !== "action"}
				onOpenChange={(open) => {
					if (!open) setRestoreTarget(null);
				}}
				onRestore={(files) => {
					const target = restoreTarget;
					setRestoreTarget(null);
					if (!target) return;
					// 恢复所选文件（单个或多个）；恢复前主进程自动建保护备份。
					void runAction(
						() => window.piDesktop.configBackups.restore(target.id, files),
						"settings.backup.restoreSuccess",
						target.id,
					);
				}}
			/>

			<SettingsSection title={t("settings.backup.title")} description={t("settings.backup.desc")}>
				<SettingRow
					level={1}
					title={<span>{t("settings.backup.createButton")}</span>}
					description={t("settings.backup.createDesc")}
				>
					<Button
						variant="secondary"
						loading={busy === "action"}
						disabled={busy !== null}
						onClick={doCreate}
					>
						{t("settings.backup.createButton")}
					</Button>
				</SettingRow>
				<p className="px-0.5 pb-1 text-caption text-muted-foreground">
					{t("settings.backup.hint")}
				</p>
			</SettingsSection>

			<SettingsSection title={t("settings.backup.listTitle")}>
				{isLoading ? (
					<p className="px-0.5 py-1 text-caption text-muted-foreground">{t("common.loading")}</p>
				) : backups.length === 0 ? (
					<p className="px-0.5 py-1 text-caption text-muted-foreground">{t("settings.backup.empty")}</p>
				) : (
					backups.map((backup) => (
						<SettingRow
							key={backup.id}
							level={1}
							title={<span>{formatTime(backup.createdAt)}</span>}
							description={formatBackupDesc(backup)}
						>
							<div className="flex items-center gap-2">
								<Button
									variant="ghost"
									size="sm"
									disabled={busy !== null}
									loading={busy === backup.id}
									onClick={() => void openDetail(backup)}
								>
									{t("settings.backup.view")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy !== null}
									onClick={() => void openRestoreDialog(backup)}
								>
									{t("settings.backup.restore")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									className="text-destructive hover:text-destructive"
									disabled={busy !== null}
									onClick={() => confirmDelete(backup)}
								>
									{t("common.delete")}
								</Button>
							</div>
						</SettingRow>
					))
				)}
			</SettingsSection>

			{(feedback || error) && (
				<div className="px-0.5 pb-1 pt-2">
					<small className={`setting-status ${error ? "error" : "success"}`}>
						{error || feedback}
					</small>
				</div>
			)}
		</>
	);
}

/** 列表行描述：文件清单 + 大小 + 触发原因。 */
function formatBackupDesc(backup: ConfigBackupMeta): string {
	const files = backup.files.join("、");
	return `${formatReason(backup.reason)} · ${files} · ${formatBytes(backup.size)}`;
}
