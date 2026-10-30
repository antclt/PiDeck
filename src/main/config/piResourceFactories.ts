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
	xuePrompts: {
		overlayDir: () => string | null;
		dbStore?: XuePromptDbStore;
		xueIndex?: XueIndexService;
	};
};

export function createPiResourceManagerFactories(deps: PiResourceFactoryDeps): PiResourceManagerFactories {
	return {
		skills: ({ home }) => new SkillManager(home, deps.translate),
		prompts: ({ home }) => new PromptManager(home, deps.translate),
		extensions: ({ environment }) => {
			const manager = new ExtensionManager(deps.extension.locator, deps.extension.getSettings, deps.extension.getPiDeckSettings, deps.extension.patchPiDeckSettings, deps.translate, deps.extension.builtInRoots);
			// 构造期绑定该发行版（实例只属于这一个目标）；生产代码里不存在对共享单例的 configureWsl 切换。
			manager.configureWsl(environment);
			return manager;
		},
		xuePrompts: ({ home, environment }) => {
			const manager = new XuePromptManager(home, deps.xuePrompts.overlayDir, { dbStore: deps.xuePrompts.dbStore, xueIndex: deps.xuePrompts.xueIndex });
			manager.configureWsl(environment);
			return manager;
		},
	};
}
