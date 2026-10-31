/**
 * WSL 资源开关的 settings.json 写入器（task-16）。
 *
 * 为什么需要单独一层：pi 的资源过滤真值在 `<发行版 HOME>/.pi/agent/settings.json` 的
 * skills/prompts/extensions/packages 条目里。池里的 WSL 管理器原先没接原生开关，toggle 会退回
 * PiDeck 本地 settings（跨目标污染）或静默无效。这里用现有 PiResourceConfigService 绑定该发行版
 * 的 settings.json，保证 toggle 只写目标 HOME，绝不触碰本机 settings。
 *
 * 读取侧：ExtensionManager/SkillManager/PromptManager 的 enabled 读取器是同步接口，这里用
 * mtime + 短 TTL 的同步快照（写后立即失效），只为列表投影服务，不作为写入结果的真值。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPackageSource } from "../../shared/piPackageSource";
import { readStringArraySetting } from "./piConfigFileStore";
import { PiResourceConfigService, projectExtensionEnabled, projectExtensionFiltered } from "./PiResourceConfigService";
import { projectResourceEnabled } from "./piResourceRules";
import type { PiResourceStateStore } from "./PiResourceStateStore";

export type WslResourceFileKind = "skills" | "prompts" | "extensions";

export type WslResourceToggleResult = { ok: true } | { ok: false; error: string };

export type WslResourceSettings = {
	/** 该目标唯一允许写入的 settings.json（测试用它证明写入隔离）。 */
	settingsPath: string;
	setFileEnabled(kind: WslResourceFileKind, value: string, enabled: boolean): Promise<WslResourceToggleResult>;
	setExtensionEnabled(input: { source: string; path?: string; enabled: boolean }): Promise<WslResourceToggleResult>;
	/** 同步投影：文件/目录类资源的精确规则是否启用（未知 = undefined，列表按默认展示）。 */
	fileEnabled(kind: WslResourceFileKind, value: string): boolean | undefined;
	/** 同步投影：扩展的启用/过滤状态（与本地装配的 reader 语义一致）。 */
	extensionState(extension: { source: string; path?: string }): { enabled: boolean; filtered?: boolean } | undefined;
};

const SNAPSHOT_TTL_MS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createWslResourceSettings(input: { home: string; state?: PiResourceStateStore }): WslResourceSettings {
	const settingsPath = join(input.home, ".pi", "agent", "settings.json");
	const service = new PiResourceConfigService({ globalSettingsPath: () => settingsPath, resolveProject: async () => null }, input.state);
	let cache: { path: string; mtimeMs: number; at: number; data: Record<string, unknown> } | null = null;

	function invalidate(): void {
		cache = null;
	}

	function snapshot(): Record<string, unknown> | undefined {
		try {
			const info = statSync(settingsPath);
			if (cache !== null && cache.path === settingsPath && cache.mtimeMs === info.mtimeMs && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.data;
			const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (!isRecord(parsed)) return undefined;
			cache = { path: settingsPath, mtimeMs: info.mtimeMs, at: Date.now(), data: parsed };
			return parsed;
		} catch {
			// 文件不存在/不可读：返回 undefined（未知），由列表默认展示，不伪造状态。
			return undefined;
		}
	}

	function toResult(result: { ok: boolean; error?: string }): WslResourceToggleResult {
		return result.ok ? { ok: true } : { ok: false, error: result.error ?? "WSL resource toggle failed." };
	}

	return {
		settingsPath,
		async setFileEnabled(kind, value, enabled) {
			try {
				const result = await service.setFileResourceEnabled({ scope: { scope: "global" }, kind, resourceId: value, enabled });
				invalidate();
				return toResult(result);
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		async setExtensionEnabled({ source, path, enabled }) {
			// 包安装的扩展开关需要停用前快照（恢复用）；没有装配 state 就明确失败，不写一半。
			if (isPackageSource(source.trim()) && input.state === undefined) {
				return { ok: false, error: "WSL 扩展包开关需要 resource state（装配缺失），本轮不支持。" };
			}
			try {
				const result = await service.setExtensionEnabled({ scope: { scope: "global" }, source, path, enabled });
				invalidate();
				return toResult(result);
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		fileEnabled(kind, value) {
			const data = snapshot();
			if (data === undefined) return undefined;
			return projectResourceEnabled({ entries: readStringArraySetting(data, kind), value, baseDir: dirname(value) });
		},
		extensionState(extension) {
			const data = snapshot();
			if (data === undefined) return undefined;
			const packages = Array.isArray(data.packages) ? data.packages : undefined;
			const enabled = projectExtensionEnabled({ source: extension.source, path: extension.path, entries: readStringArraySetting(data, "extensions"), packages });
			if (enabled === undefined) return undefined;
			const filtered = projectExtensionFiltered({ source: extension.source, packages });
			return filtered === undefined ? { enabled } : { enabled, filtered };
		},
	};
}
