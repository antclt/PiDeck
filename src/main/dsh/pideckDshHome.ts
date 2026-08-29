/**
 * PiDeck 特有文件在 DSH_HOME 下的统一落点：`$DSH_HOME/.pideck/`。
 *
 * 为什么收进一个点目录：
 * - ~/.dsh 与 dsh CLI 共用，根下散落 pideck 私有文件会让用户难以区分
 *   「哪个是 dsh 的、哪个是 PiDeck 的」；统一后备份/迁移/清理只需处理一个目录；
 * - 避免与 dsh 未来新增的根级文件撞名。
 *
 * 边界（不可逾越）：
 * - DSH 官方约定文件（storages/session_projcache.json、storages/workspace.json、
 *   .credentials.yaml、sessions/、settings.yaml）由 dsh CLI 读写，**不进 .pideck**。
 *
 * ── 生命周期（一次性迁移）────────────────────────────────────────────
 * migrateLegacyPideckDshFiles 是**一次性迁移**：旧布局（`~/.dsh/.pideck-archive/`、
 * 根下 `usage-probes.json`、根下 `.pideck-host.lock`）只存在于本版之前的开发/试用环境，
 * 发布版用户从全新布局（`~/.dsh/.pideck/`）开始，迁移对用户环境是空操作。
 * 确认旧布局无残留后（建议随下一版）删除该迁移函数及其调用（DshHost）与测试；
 * 路径函数（pideckDshHome / pideckHostLockPath / pideckArchivePath /
 * pideckUsageProbesPath / pideckUsageProbesDir）是当前布局的读取路径，永远保留。
 * ────────────────────────────────────────────────────────────────────
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/** PiDeck 特有文件在 DSH_HOME 下的统一子目录名。 */
export const PIDECK_DSH_DIR = ".pideck";

/** DSH_HOME 下的 PiDeck 私有目录（不存在时调用方 mkdirSync 创建）。 */
export function pideckDshHome(dshHome: string): string {
	return join(dshHome, PIDECK_DSH_DIR);
}

/** DSH host 并发互斥锁（B6：同一 DSH_HOME 只允许一个宿主实例）。 */
export function pideckHostLockPath(dshHome: string): string {
	return join(pideckDshHome(dshHome), "host.lock");
}

/** DSH 会话归档目录（archive/restore 搬移区）。 */
export function pideckArchivePath(dshHome: string): string {
	return join(pideckDshHome(dshHome), "archive");
}

/** DSH 用量查询配置文件（与 pi 侧 ~/.pi/agent/usage-probes.json 同构）。 */
export function pideckUsageProbesPath(dshHome: string): string {
	return join(pideckDshHome(dshHome), "usage-probes.json");
}

/** DSH 用量查询配置目录（saveUsageProbeForProvider 的 configDir，文件在其下）。 */
export function pideckUsageProbesDir(dshHome: string): string {
	return pideckDshHome(dshHome);
}

/**
 * 一次性迁移旧版 PiDeck 数据（幂等；失败静默——不阻塞 DSH host 启动）：
 * - `$DSH_HOME/.pideck-archive/` → `$DSH_HOME/.pideck/archive/`
 * - `$DSH_HOME/usage-probes.json` → `$DSH_HOME/.pideck/usage-probes.json`
 * - `$DSH_HOME/.pideck-host.lock` → `$DSH_HOME/.pideck/host.lock`
 * 目标已存在 = 跳过（保留新数据）；源不存在 = 无操作。
 *
 * @deprecated 一次性迁移：旧布局仅存在于本版之前的开发/试用环境，发布版用户
 *   从全新布局开始，本函数对用户环境是空操作。确认旧布局无残留后（建议随下一版）
 *   删除本函数 + DshHost 中的调用 + tests/pideckDshHome.test.mjs 的迁移用例
 *   （路径函数保留）。见文件头「生命周期」说明。
 */
export function migrateLegacyPideckDshFiles(dshHome: string): void {
	const pideck = pideckDshHome(dshHome);
	try {
		const moves: Array<[string, string]> = [
			[join(dshHome, ".pideck-archive"), pideckArchivePath(dshHome)],
			[join(dshHome, "usage-probes.json"), pideckUsageProbesPath(dshHome)],
			[join(dshHome, ".pideck-host.lock"), pideckHostLockPath(dshHome)],
		];
		for (const [source, target] of moves) {
			if (!existsSync(source)) continue;
			if (existsSync(target)) continue;
			mkdirSync(pideck, { recursive: true });
			renameSync(source, target);
		}
	} catch {
		// 迁移失败（权限/占用）：保留旧位置，读取路径仍会做旧位置兜底，不阻塞启动。
	}
}
