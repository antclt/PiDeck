/**
 * Production factories for PiResourceManagerPool (W1 assembly helper).
 *
 * Kept in a separate module so main/index.ts only passes narrow dependencies instead of re-writing four
 * constructors. The ExtensionManager/XuePromptManager constructors do not take a WslEnvironment, so the factory
 * binds it once right after construction — the single allowed `configureWsl` call site in production code. It is
 * never called on a shared singleton, so no window/profile can switch another target's directories.
 */

import type { BuiltInExtensionPathRoots } from "../extensions/builtInExtensions";
import { ExtensionManager } from "../extensions/ExtensionManager";
import type { PiLocator } from "../pi/PiLocator";
import type { XueIndexService } from "../prompts/XueIndexService";
import type { XuePromptDbStore } from "../prompts/XuePromptDbStore";
import { XuePromptManager } from "../prompts/XuePromptManager";
import { PromptManager } from "../prompts/PromptManager";
import { SkillManager } from "../skills/SkillManager";
import type { AppSettings } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { PiResourceManagerFactories } from "./PiResourceManagerPool";
import type { PiResourceStateStore } from "./PiResourceStateStore";
import { createWslResourceSettings } from "./WslResourceSettings";

type PiResourceTranslate = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

export type PiResourceFactoryDeps = {
	/** mainCopy: same translator the local managers receive. */
	translate: PiResourceTranslate;
	extension: {
		locator: PiLocator;
		getSettings: () => AppSettings;
		getPiDeckSettings: () => AppSettings;
		patchPiDeckSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
		builtInRoots?: BuiltInExtensionPathRoots;
	};
	/**
	 * WSL 目标的整包开关恢复快照存储（装配层注入）。缺省时 skills/prompts 与本地文件扩展开关仍可用，
	 * 但扩展包开关会明确失败（不写一半），绝不退回本机 settings。
	 */
	resourceState?: PiResourceStateStore;
	xuePrompts: {
		overlayDir: () => string | null;
		dbStore?: XuePromptDbStore;
		xueIndex?: XueIndexService;
	};
};

export function createPiResourceManagerFactories(deps: PiResourceFactoryDeps): PiResourceManagerFactories {
	return {
		skills: ({ home }) => {
			const manager = new SkillManager(home, deps.translate);
			const settings = createWslResourceSettings({ home, state: deps.resourceState });
			// 开关写该发行版 HOME 的 settings.json（精确 ±path 规则），读取器给列表做状态投影。
			manager.configureNativeToggle((skillPath, enabled) => settings.setFileEnabled("skills", skillPath, enabled));
			manager.configureNativeEnabledReader((skillPath) => settings.fileEnabled("skills", skillPath));
			return manager;
		},
		prompts: ({ home }) => {
			const manager = new PromptManager(home, deps.translate);
			const settings = createWslResourceSettings({ home, state: deps.resourceState });
			manager.configureNativeToggle((templatePath, enabled) => settings.setFileEnabled("prompts", templatePath, enabled));
			manager.configureNativeEnabledReader((templatePath) => settings.fileEnabled("prompts", templatePath));
			return manager;
		},
		extensions: ({ home, environment }) => {
			const manager = new ExtensionManager(deps.extension.locator, deps.extension.getSettings, deps.extension.getPiDeckSettings, deps.extension.patchPiDeckSettings, deps.translate, deps.extension.builtInRoots);
			// 构造期绑定该发行版（实例只属于这一个目标）；生产代码里不存在对共享单例的 configureWsl 切换。
			manager.configureWsl(environment);
			const settings = createWslResourceSettings({ home, state: deps.resourceState });
			// 开关写该发行版 settings.json 的 extensions/packages 条目；项目作用域属于本机项目目录，WSL 目标拒绝。
			manager.configureNativeToggle(async ({ source, path, scope, enabled }) => {
				if (scope === "project") return { ok: false, error: "WSL 目标不支持项目作用域的扩展开关。" };
				return await settings.setExtensionEnabled({ source, path, enabled });
			});
			manager.configureNativeEnabledReader((extension) => settings.extensionState({ source: extension.source, path: extension.path }));
			return manager;
		},
		xuePrompts: ({ home, environment }) => {
			const manager = new XuePromptManager(home, deps.xuePrompts.overlayDir, { dbStore: deps.xuePrompts.dbStore, xueIndex: deps.xuePrompts.xueIndex });
			manager.configureWsl(environment);
			return manager;
		},
	};
}
