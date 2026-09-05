import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import ignore from "ignore";
import {
	addIgnoreRules,
	applyPatterns,
	isDirEntry,
	isFileEntry,
	passesOverrides,
	readSettingsObject,
	readStringArray,
	resolveFromBase,
	splitResourceEntries,
	toPosixPath,
} from "../resourceWhitelist";
import { globalPromptOverrideKey } from "../../shared/resourceIdentity";
import { readProjectResourceOverrides } from "../projects/projectResourceOverrides";
import { resolveConfiguredPackageResources } from "../packageResourceResolver";

/**
 * 提示词模板白名单模式解析器：计算 RPC 启动时应通过 --prompt-template 注入的模板路径。
 *
 * 与技能白名单（skillWhitelistResolver）同构：pi 的 `--no-prompt-templates` 关闭自动发现，
 * 显式 `--prompt-template <path>` 仍加载——「禁用 = 不加载」唯一可靠手段是白名单注入。
 *
 * 枚举与过滤规则对齐 pi 0.85 的 DefaultPackageManager.resolve() / collectFiles：
 *   1. ~/.pi/agent/prompts/*.md（全局，递归收集全部 .md，含 .d.md——与 pi 的 collectFiles
 *      /\.md$/ 一致，PiDeck 列表隐藏的 .d.md 在 pi 中同样会加载）
 *   2. <cwd>/.pi/prompts/*.md（项目，trusted 后；注意：prompts 没有 .agents 目录，
 *      与 skills 不同——pi 只扫 .pi/prompts）
 *   3. user/project settings.json 的 prompts 数组：plain 条目 = 显式路径；
 *      `!`/`+`/`-` 前缀条目 = 自动发现过滤规则
 *   4. packages：包内 prompts/ 约定目录与 package.json pi.prompts 声明；
 *      对象条目 { source, prompts, autoload } 的过滤语义（空数组 = 全禁，autoload:false = delta）
 *   5. ignore 规则（.gitignore/.ignore/.fdignore，逐目录前缀化）应用于自动发现目录
 *
 * 返回 null = 无禁用项，白名单关闭（pi 自动发现，兼容 PiDeck 未跟踪的手动安装）；
 * 返回数组（可能为空）= 白名单开启，调用方需同时传 --no-prompt-templates。
 *
 * Auto-discovered prompt directories are top-level only; explicit/package directories recurse.
 * Package sources use managed npm/git/local paths and expand manifest globs exactly as pi 0.85.
 */
export function resolveEnabledPromptPaths(
	options: PromptWhitelistResolverOptions,
): string[] | null {
	const { cwd } = options;
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");
	const projectBaseDir = join(cwd, ".pi");
	const includeProjectResources = options.includeProjectResources !== false;

	const userSettings = readSettingsObject(join(agentDir, "settings.json"));
	const projectSettings = includeProjectResources
		? readSettingsObject(join(projectBaseDir, "settings.json"))
		: {};

	// 全局、项目本地和项目继承覆盖分别匹配，避免同名模板跨作用域串扰。
	const globalDisabledKeys = new Set(
		(options.disabledNames ?? []).map((name) => name.toLowerCase()),
	);
	const projectDisabledKeys = new Set(
		readStringArray(projectSettings, "disabledPrompts").map((name) => name.toLowerCase()),
	);
	const inheritedDisabledKeys = new Set(
		includeProjectResources
			? readProjectResourceOverrides(cwd).disabledGlobalPrompts
			: [],
	);
	if (
		includeProjectResources &&
		globalDisabledKeys.size === 0 &&
		projectDisabledKeys.size === 0 &&
		inheritedDisabledKeys.size === 0
	) return null;

	const isGlobalEnabled = (promptFile: string) => {
		const name = basename(promptFile).replace(/\.md$/i, "").toLowerCase();
		return (
			!globalDisabledKeys.has(name) &&
			!inheritedDisabledKeys.has(globalPromptOverrideKey(name))
		);
	};
	const isProjectEnabled = (promptFile: string) => {
		const name = basename(promptFile).replace(/\.md$/i, "").toLowerCase();
		return !projectDisabledKeys.has(name);
	};

	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (path: string) => {
		if (!path || seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};

	// settings.prompts 数组的 plain 条目 = 显式路径；patterns 条目 = 该作用域自动发现过滤
	const { plain: userPlain, patterns: userOverrides } = splitResourceEntries(
		Array.isArray(userSettings.prompts) ? userSettings.prompts : [],
	);
	const { plain: projectPlain, patterns: projectOverrides } = splitResourceEntries(
		Array.isArray(projectSettings.prompts) ? projectSettings.prompts : [],
	);

	// 1) pi auto-discovery only reads top-level .md files from each prompts directory.
	collectAutoPromptDir(join(agentDir, "prompts"), isGlobalEnabled, addPath, agentDir, userOverrides);
	if (includeProjectResources) {
		collectAutoPromptDir(join(projectBaseDir, "prompts"), isProjectEnabled, addPath, projectBaseDir, projectOverrides);
	}

	// 2) Explicit settings paths can name a file or recursively enumerate a directory.
	collectSettingsPrompts(agentDir, userPlain, userOverrides, isGlobalEnabled, addPath);
	if (includeProjectResources) {
		collectSettingsPrompts(projectBaseDir, projectPlain, projectOverrides, isProjectEnabled, addPath);
	}

	// 3) Resolve package precedence, filters, manifest globs, and managed git/npm locations once.
	for (const resource of resolveConfiguredPackageResources({
		resourceType: "prompts",
		userSettingsFile: join(agentDir, "settings.json"),
		userBaseDir: agentDir,
		projectSettingsFile: includeProjectResources ? join(projectBaseDir, "settings.json") : undefined,
		projectBaseDir: includeProjectResources ? projectBaseDir : undefined,
		collectDirectory: collectPromptDirFiles,
	})) {
		if (!resource.enabled) continue;
		const enabled = resource.scope === "project"
			? isProjectEnabled(resource.path)
			: isGlobalEnabled(resource.path);
		if (enabled) addPath(resource.path);
	}

	return paths;
}

export type PromptWhitelistResolverOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()（与 PiProcessOptions.agentHomeDir 语义一致）。 */
	agentHomeDir?: string;
	/** 会话项目根（pi 的 cwd），决定项目级 .pi/prompts。 */
	cwd: string;
	/** False when the trust decision rejects project resources. */
	includeProjectResources?: boolean;
	/** PiDeck settings 中禁用的全局模板名（比较时小写）。 */
	disabledNames: string[];
};

/** Auto-discovered prompts are top-level files only in pi 0.85. */
function collectAutoPromptDir(
	dir: string,
	isPiDeckEnabled: (promptFile: string) => boolean,
	addPath: (path: string) => void,
	overridesBase: string,
	overrides: string[],
): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);
		if (!isFileEntry(entry, fullPath) || !entry.name.toLowerCase().endsWith(".md")) continue;
		if (ig.ignores(toPosixPath(relative(dir, fullPath)))) continue;
		if (isPiDeckEnabled(fullPath) && passesOverrides(fullPath, overridesBase, overrides)) {
			addPath(fullPath);
		}
	}
}

/**
 * 递归收集显式/package 目录下全部 .md 模板（对齐 pi 的 collectFiles）：
 * 无 skills 的 pi/agents 模式差异——所有层级的 .md 都是模板（含 .d.md），
 * 跳过 . 开头与 node_modules；ignore 规则从 root 起逐目录应用。
 */
function collectPromptDir(
	dir: string,
	isPiDeckEnabled: (promptFile: string) => boolean,
	addPath: (path: string) => void,
	overridesBase: string,
	overrides: string[],
	root = dir,
	ig?: ReturnType<typeof ignore>,
): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // 目录不存在：无模板
	}
	const igRef = ig ?? ignore();
	addIgnoreRules(igRef, dir, root);

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const relPath = toPosixPath(relative(root, fullPath));

		if (isDirEntry(entry, fullPath)) {
			if (igRef.ignores(`${relPath}/`)) continue;
			collectPromptDir(fullPath, isPiDeckEnabled, addPath, overridesBase, overrides, root, igRef);
			continue;
		}
		if (!isFileEntry(entry, fullPath)) continue;
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		if (igRef.ignores(relPath)) continue;
		if (isPiDeckEnabled(fullPath) && passesOverrides(fullPath, overridesBase, overrides)) {
			addPath(fullPath);
		}
	}
}

/**
 * settings.json prompts 数组的显式路径（plain 条目）：文件直接注入，目录递归枚举
 * （pi 的 collectFilesFromPaths → collectResourceFiles(dir, "prompts") = collectFiles(dir, /\.md$/)，
 * 无 ignore）；整个显式集合再过 patterns（! + -）过滤。
 */
function collectSettingsPrompts(
	base: string,
	plain: string[],
	patterns: string[],
	isPiDeckEnabled: (promptFile: string) => boolean,
	addPath: (path: string) => void,
): void {
	const allFiles: string[] = [];
	for (const rawPath of plain) {
		const resolved = resolveFromBase(rawPath, base);
		if (!resolved || !existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				allFiles.push(...collectPromptDirFiles(resolved));
			} else {
				allFiles.push(resolved);
			}
		} catch {
			// 路径不可读：跳过，pi 侧同样会忽略
		}
	}
	const enabledSet = applyPatterns(allFiles, patterns, base);
	for (const file of allFiles) {
		if (enabledSet.has(file) && isPiDeckEnabled(file)) addPath(file);
	}
}

/** 枚举目录下全部模板文件（无 ignore——与 pi 的 collectResourceFiles 一致）。 */
function collectPromptDirFiles(dir: string): string[] {
	const files: string[] = [];
	collectPromptDir(dir, () => true, (path) => files.push(path), dir, []);
	return files;
}
