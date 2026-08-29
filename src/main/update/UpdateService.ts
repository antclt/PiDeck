/**
 * 主进程后台更新检查服务（无配额方案）。
 *
 * 职责：
 *   - 启动延迟 + 周期（默认 2h）自动检查 PiDeck 与 Pi CLI 更新；
 *   - 结果快照持久化到 settings（lastCheckAt / notified / skipped），跨重启保留；
 *   - 通过 app:update-status-changed 推送快照给渲染层（角标 + “每版本只弹一次”判定）。
 *
 * 手动「检测更新」不经过本服务（保留 appCheckUpdate / piUpdateCheck 独立 handler，
 * 返回完整 AppUpdateInfo 供弹窗展示）；手动完成后由渲染层拉取最新快照刷新角标。
 *
 * 生命周期：start() 装配启动调度；stop() 在退出路径清理定时器（配对清理）。
 */

import type { AppSettings } from "../../shared/types/settings";
import type { AppUpdateStatusSnapshot } from "../../shared/types/app";
import type { PiUpdateCheckResult } from "../../shared/types";
import type { SettingsStore } from "../settings/SettingsStore";
import { checkAppUpdate, UPDATE_REPO, UPDATE_REPO_OWNER } from "./appUpdateCheck";

export type UpdateServiceDeps = {
	settingsStore: Pick<SettingsStore, "get" | "update">;
	/** Pi CLI 版本检查（extensionManager.checkPiUpdate 注入）。 */
	checkPiUpdate?: () => Promise<PiUpdateCheckResult>;
	/** 推送给渲染层（mainWindow.webContents.send 注入）。 */
	sendToRenderer?: (snapshot: AppUpdateStatusSnapshot) => void;
	log?: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => void;
	getCurrentVersion: () => string;
	getInstallationType: () => "portable" | "installed";
	/** GitHub 仓库坐标。 */
	owner?: string;
	repo?: string;
};

/** 默认检查周期：2h（无配额限制；认证/云同步不需要）。 */
export const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** 启动后首次检查延迟（ms）。 */
export const DEFAULT_START_DELAY_MS = 30 * 1000;
/** 抖动上界（ms）：打散全网用户检查时刻，避免同时段打爆 GitHub 静态层。 */
export const DEFAULT_JITTER_MAX_MS = 60 * 1000;

type AppCheckResult = { latestVersion: string; hasUpdate: boolean };
type PiCheckResult = {
	currentVersion?: string;
	latestVersion?: string;
	hasUpdate: boolean;
	error?: string;
};

export class UpdateService {
	private readonly deps: UpdateServiceDeps;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private running = false;
	private lastApp: AppCheckResult | null = null;
	private lastPi: PiCheckResult | null = null;

	constructor(deps: UpdateServiceDeps) {
		this.deps = deps;
	}

	/** 启动后台调度：延迟首查 + 固定周期续查（带抖动）。 */
	start(options?: { startDelayMs?: number; intervalMs?: number }): void {
		if (this.disposed) return;
		this.scheduleNext(options?.startDelayMs ?? DEFAULT_START_DELAY_MS, options?.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
	}

	/** 立即执行一轮后台检查（供手动触发后同步快照等场景）。 */
	async checkNow(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const settings = this.deps.settingsStore.get();
			if (settings.disableUpdateCheck) return;
			const [appResult, piResult] = await Promise.allSettled([
				this.checkApp(),
				this.checkPi(),
			]);
			if (appResult.status === "fulfilled") this.lastApp = appResult.value;
			if (piResult.status === "fulfilled") this.lastPi = piResult.value;
			// 检查时间持久化（低频写，2h 一次），供 UI 显示上次检查时间。
			await this.deps.settingsStore
				.update({ updateLastCheckAt: Date.now() })
				.catch(() => undefined);
			this.pushSnapshot();
		} finally {
			this.running = false;
		}
	}

	/** 记录「已提示过该版本」（渲染层弹窗/提示关闭后调用，实现每版本只提示一次）。 */
	async notifySeen(kind: "app" | "pi", version: string): Promise<void> {
		const patch: Partial<AppSettings> =
			kind === "app" ? { updateNotifiedVersion: version } : { updatePiNotifiedVersion: version };
		await this.deps.settingsStore.update(patch).catch(() => undefined);
		this.pushSnapshot();
	}

	/** 手动「检测更新」完成后记录结果并推送快照（角标/设置页高亮与手动结果一致）。 */
	recordAppUpdateResult(info: { latestVersion: string; hasUpdate: boolean }): void {
		if (!info.latestVersion) return;
		this.lastApp = { latestVersion: info.latestVersion, hasUpdate: info.hasUpdate };
		this.pushSnapshot();
	}

	/** 跳过某个 PiDeck 版本（该版本不再主动提示，手动检测仍可查看）。 */
	async skipVersion(version: string): Promise<void> {
		if (!version) return;
		await this.deps.settingsStore.update({ updateSkippedVersion: version }).catch(() => undefined);
		this.pushSnapshot();
	}

	/** 当前快照（从持久化状态 + 最近一次检查结果组装）。 */
	getSnapshot(): AppUpdateStatusSnapshot {
		const settings = this.deps.settingsStore.get();
		return {
			lastCheckAt: settings.updateLastCheckAt,
			app: this.lastApp
				? {
						latestVersion: this.lastApp.latestVersion,
						hasUpdate: this.lastApp.hasUpdate,
						skippedVersion: settings.updateSkippedVersion,
						notifiedVersion: settings.updateNotifiedVersion,
					}
				: null,
			piCli: this.lastPi
				? {
						currentVersion: this.lastPi.currentVersion,
						latestVersion: this.lastPi.latestVersion,
						hasUpdate: this.lastPi.hasUpdate,
						notifiedVersion: settings.updatePiNotifiedVersion,
						error: this.lastPi.error,
					}
				: null,
		};
	}

	/** 退出路径清理定时器（配对清理）。 */
	stop(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private async checkApp(): Promise<AppCheckResult> {
		const info = await checkAppUpdate({
			// 默认坐标从 appUpdateCheck 的常量取（仓库更名后唯一事实来源），deps 仍可覆盖便于测试。
			owner: this.deps.owner ?? UPDATE_REPO_OWNER,
			repo: this.deps.repo ?? UPDATE_REPO,
			currentVersion: this.deps.getCurrentVersion(),
			installationType: this.deps.getInstallationType(),
			log: this.deps.log,
		});
		return { latestVersion: info.latestVersion, hasUpdate: info.hasUpdate };
	}

	private async checkPi(): Promise<PiCheckResult> {
		if (!this.deps.checkPiUpdate) return { hasUpdate: false };
		const result = await this.deps.checkPiUpdate();
		return {
			currentVersion: result.currentVersion,
			latestVersion: result.latestVersion,
			hasUpdate: result.hasUpdate,
			error: result.error,
		};
	}

	private pushSnapshot(): void {
		this.deps.sendToRenderer?.(this.getSnapshot());
	}

	private scheduleNext(delayMs: number, intervalMs: number): void {
		if (this.disposed) return;
		const jitter = Math.floor(Math.random() * DEFAULT_JITTER_MAX_MS);
		this.timer = setTimeout(() => {
			void this.checkNow().finally(() => {
				this.scheduleNext(intervalMs, intervalMs);
			});
		}, Math.max(0, delayMs + jitter));
	}
}
