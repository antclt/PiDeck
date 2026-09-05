import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import ignore from "ignore";
import {
	addIgnoreRules,
	applyPatterns,
	deltaEnabled,
	isDirEntry,
	isFileEntry,
	passesOverrides,
	readSettingsObject,
	readStringArray,
	resolveFromBase,
	splitResourceEntries,
	toPosixPath,
} from "../resourceWhitelist";

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
 * 已知限制与 skillWhitelistResolver 相同：git 类包源无法推导、manifest glob 条目跳过、
 * ignore 仅作用于自动发现目录。
 */
export function resolveEnabledPromptPaths(
	options: PromptWhitelistResolverOptions,
): string[] | null {
	const { cwd } = options;
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");

	const userSettings = readSettingsObject(join(agentDir, "settings.json"));
	const projectSettings = readSettingsObject(join(cwd, ".pi", "settings.json"));

	// 禁用来源：PiDeck 全局设置 ∪ 项目 .pi/settings.json（PromptManager 写入）。
	const disabledKeys = new Set(
		[...(options.disabledNames ?? []), ...readStringArray(projectSettings, "disabledPrompts")].map(
			(name) => name.toLowerCase(),
		),
	);
	// 无任何禁用时返回 null（白名单关闭），无需扫描。
	if (disabledKeys.size === 0) return null;

	const isPiDeckEnabled = (promptFile: string) => {
		const name = basename(promptFile).replace(/\.md$/i, "").toLowerCase();
		return !disabledKeys.has(name);
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

	// 1) 全局 + 项目模板目录（递归收集 .md，无 agents 目录）
	collectPromptDir(join(agentDir, "prompts"), isPiDeckEnabled, addPath, agentDir, userOverrides);
	collectPromptDir(join(cwd, ".pi", "prompts"), isPiDeckEnabled, addPath, cwd, projectOverrides);

	// 2) settings.json prompts 数组的显式路径（user + project；plain 条目经 patterns 过滤）
	collectSettingsPrompts(agentDir, userPlain, userOverrides, isPiDeckEnabled, addPath);
	collectSettingsPrompts(cwd, projectPlain, projectOverrides, isPiDeckEnabled, addPath);

	// 3) packages 的包内模板（npm 安装目录下的 prompts/ 或 pi.prompts 声明）
	collectPackagePrompts(join(agentDir, "settings.json"), agentDir, isPiDeckEnabled, addPath);
	collectPackagePrompts(join(cwd, ".pi", "settings.json"), cwd, isPiDeckEnabled, addPath);

	return paths;
}

export type PromptWhitelistResolverOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()（与 PiProcessOptions.agentHomeDir 语义一致）。 */
	agentHomeDir?: string;
	/** 会话项目根（pi 的 cwd），决定项目级 .pi/prompts。 */
	cwd: string;
	/** PiDeck settings 中禁用的全局模板名（比较时小写）。 */
	disabledNames: string[];
};

/**
 * 递归收集目录下全部 .md 模板（对齐 pi 的 collectFiles(dir, /\.md$/)）：
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

/**
 * 枚举 npm 包内的模板（对齐 pi 的 collectPackageResources）：
 * 包内 prompts/ 约定目录或 package.json 的 pi.prompts 声明；
 * 对象条目 { source, prompts, autoload } 的过滤语义与技能相同。
 * git:/github:/https: 源安装目录无法稳定推导，跳过。
 */
function collectPackagePrompts(
	settingsFile: string,
	scopeBase: string,
	isPiDeckEnabled: (promptFile: string) => boolean,
	addPath: (path: string) => void,
): void {
	const settings = readSettingsObject(settingsFile);
	const packages = settings.packages;
	if (!Array.isArray(packages)) return;

	for (const entry of packages) {
		const filter = typeof entry === "object" && entry !== null
			? (entry as { source?: unknown; prompts?: unknown; autoload?: unknown })
			: null;
		const source = typeof entry === "string" ? entry : filter?.source;
		if (typeof source !== "string" || !source) continue;

		const pkgDir = resolvePackageDir(source, scopeBase);
		if (!pkgDir) continue;

		const manifestPrompts = readManifestPrompts(pkgDir);
		let allFiles: string[];
		if (manifestPrompts) {
			allFiles = manifestPrompts.files;
		} else {
			allFiles = collectPromptDirFiles(join(pkgDir, "prompts"));
		}

		const promptPatterns = Array.isArray(filter?.prompts)
			? filter.prompts.filter((item): item is string => typeof item === "string")
			: null;

		let files: string[];
		if (promptPatterns === null) {
			// 无过滤：manifest patterns 已在 readManifestPrompts 内过滤
			files = allFiles;
		} else if (filter?.autoload === false) {
			// delta：默认全加载，只按 pattern 开关
			files = allFiles.filter((f) => deltaEnabled(f, promptPatterns, pkgDir));
		} else if (promptPatterns.length === 0) {
			// 空数组显式禁用该包全部模板（pi 的 applyPackageFilter 语义）
			files = [];
		} else {
			const enabledSet = applyPatterns(allFiles, promptPatterns, pkgDir);
			files = allFiles.filter((f) => enabledSet.has(f));
		}

		for (const file of files) {
			if (isPiDeckEnabled(file)) addPath(file);
		}
	}
}

/** 解析 packages 条目的安装目录（与 skillWhitelistResolver.resolvePackageDir 同规则）。 */
function resolvePackageDir(source: string, scopeBase: string): string | null {
	if (source.startsWith("npm:")) {
		const name = source.slice(4).trim();
		if (!name) return null;
		const candidate = join(scopeBase, "npm", "node_modules", name);
		return existsSync(candidate) ? candidate : null;
	}
	if (source.startsWith("file:") || !/^(?:npm|git|github|https?):/i.test(source)) {
		const rawPath = source.startsWith("file:") ? source.slice(5) : source;
		const candidate = resolveFromBase(rawPath, scopeBase);
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null; // git:/github:/https: 无法稳定推导
}

/**
 * 读取包的 pi.prompts manifest：plain 条目展开成文件集合（文件直接、目录递归），
 * `!`/`+`/`-` 前缀条目按 applyPatterns 过滤。含 glob 的 plain 条目跳过（已知限制）。
 * 无声明返回 null（调用方 fallback 约定目录）。
 */
function readManifestPrompts(pkgDir: string): { files: string[] } | null {
	let pkg: { pi?: { prompts?: string[] } };
	try {
		pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
			pi?: { prompts?: string[] };
		};
	} catch {
		return null; // package.json 缺失/损坏
	}
	const entries = pkg.pi?.prompts;
	if (!Array.isArray(entries) || entries.length === 0) return null;

	const { plain, patterns } = splitResourceEntries(entries);
	const allFiles: string[] = [];
	for (const raw of plain) {
		if (raw.includes("*") || raw.includes("?")) continue; // glob 条目：已知限制跳过
		const resolved = resolve(join(pkgDir, raw));
		if (!existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				allFiles.push(...collectPromptDirFiles(resolved));
			} else {
				allFiles.push(resolved);
			}
		} catch {
			// 不可读：跳过
		}
	}
	const enabledSet = applyPatterns(allFiles, patterns, pkgDir);
	return { files: allFiles.filter((f) => enabledSet.has(f)) };
}
