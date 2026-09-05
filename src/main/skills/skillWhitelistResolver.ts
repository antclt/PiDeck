import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import {
	addIgnoreRules,
	applyPatterns,
	deltaEnabled,
	isDirEntry,
	isFileEntry,
	isOverridePattern,
	matchesAnyPattern,
	passesOverrides,
	readSettingsObject,
	readStringArray,
	resolveFromBase,
	SKILL_FILE,
	splitResourceEntries,
	toPosixPath,
} from "../resourceWhitelist";

/**
 * 技能白名单模式解析器：计算 RPC 启动时应通过 --skill 注入的技能路径。
 *
 * 为什么需要它：pi 的 skill frontmatter `disable-model-invocation` 只阻止模型自动调用，
 * 技能仍被加载（用户仍可 /skill:name 手动触发）。完全禁用唯一可靠的手段是
 * `--no-skills`（关自动发现）+ 显式 `--skill` 白名单（`--no-skills` 下仍加载）。
 * 但 -ns 下 pi 连目录扫描、settings.skills 数组、包技能都不发现，所以启用白名单时
 * PiDeck 必须把「pi 本来会加载的全部技能」自己枚举出来，剔除禁用项后逐条注入。
 *
 * 枚举与过滤规则逐条对齐 pi 0.85 的 DefaultPackageManager.resolve() /
 * collectSkillEntries / addIgnoreRules / isEnabledByOverrides / applyPatterns：
 *   1. ~/.pi/agent/skills（pi 模式：顶层 md 也是技能）与 ~/.agents/skills（agents 模式：只嵌套）
 *   2. <cwd>/.pi/skills（pi 模式）与 <cwd> 及祖先目录的 .agents/skills（到 git repo root）
 *   3. user/project settings.json 的 skills 数组：plain 条目 = 显式路径；
 *      `!`/`+`/`-` 前缀条目 = 自动发现过滤规则（exclude / force-include / force-exclude）
 *   4. packages：包内 skills/ 约定目录与 package.json pi.skills 声明；
 *      对象条目 { source, skills, autoload } 的过滤语义（空数组 = 全禁，autoload:false = delta）
 *   5. ignore 规则（.gitignore/.ignore/.fdignore，逐目录前缀化）应用于自动发现目录
 *
 * 返回 null = 无禁用项，白名单关闭（pi 自动发现，兼容 PiDeck 未跟踪的手动安装）；
 * 返回数组（可能为空）= 白名单开启，调用方需同时传 --no-skills。
 *
 * 已知限制（与 enabledExtensionResolver 同级别）：
 *   - git:/github:/https: 包源的技能安装目录无法稳定推导，命中即跳过；
 *   - package.json pi.skills 声明中的 glob 条目（含 * ? 的 plain 路径）不展开
 *     （pi 用 node:fs globSync 展开；Electron 内置 Node 版本不确定，显式跳过避免误加载）；
 *   - ignore 规则仅在自动发现目录生效，与 pi 一致（显式路径不受 ignore 影响）。
 */
export function resolveEnabledSkillPaths(
	options: SkillWhitelistResolverOptions,
): string[] | null {
	const { cwd } = options;
	const home = options.agentHomeDir?.trim() || homedir();
	const agentDir = join(home, ".pi", "agent");

	const userSettings = readSettingsObject(join(agentDir, "settings.json"));
	const projectSettings = readSettingsObject(join(cwd, ".pi", "settings.json"));

	// 禁用来源：PiDeck 全局设置 ∪ 项目 .pi/settings.json（ProjectResourceManager 写入）。
	// 两者皆空时仍需扫描：frontmatter 的 disable-model-invocation（老版禁用语义）命中
	// 也会启用白名单并排除——保证旧禁用状态升级后直接变为「不加载」，无需用户重新操作。
	const disabledKeys = new Set(
		[...(options.disabledNames ?? []), ...readStringArray(projectSettings, "disabledSkills")].map(
			(name) => name.toLowerCase(),
		),
	);
	// 扫描过程中发现的 PiDeck 禁用/frontmatter 排除项计数：无任何禁用时返回 null（白名单关闭）。
	const excluded = { count: 0 };
	const isPiDeckEnabled = (skillFile: string) => {
		const enabled = isEnabledSkill(skillFile, disabledKeys);
		if (!enabled) excluded.count += 1;
		return enabled;
	};

	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (path: string) => {
		if (!path || seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};

	// settings.skills 数组的 plain 条目 = 显式路径；patterns 条目 = 该作用域自动发现过滤
	const { plain: userPlain, patterns: userOverrides } = splitResourceEntries(
		Array.isArray(userSettings.skills) ? userSettings.skills : [],
	);
	const { plain: projectPlain, patterns: projectOverrides } = splitResourceEntries(
		Array.isArray(projectSettings.skills) ? projectSettings.skills : [],
	);

	// 1) 全局技能目录：~/.pi/agent/skills（pi 模式）+ ~/.agents/skills（agents 模式）
	collectSkillDir(join(agentDir, "skills"), "pi", isPiDeckEnabled, addPath, agentDir, userOverrides);
	collectSkillDir(join(home, ".agents", "skills"), "agents", isPiDeckEnabled, addPath, agentDir, userOverrides);

	// 2) 项目技能目录：<cwd>/.pi/skills（pi 模式）+ cwd 及祖先的 .agents/skills（到 git root）
	collectSkillDir(join(cwd, ".pi", "skills"), "pi", isPiDeckEnabled, addPath, cwd, projectOverrides);
	for (const dir of collectAncestorAgentsSkillDirs(cwd)) {
		collectSkillDir(dir, "agents", isPiDeckEnabled, addPath, cwd, projectOverrides);
	}

	// 3) settings.json skills 数组的显式路径（user + project；plain 条目经 patterns 过滤）
	collectSettingsSkills(agentDir, userPlain, userOverrides, isPiDeckEnabled, addPath);
	collectSettingsSkills(cwd, projectPlain, projectOverrides, isPiDeckEnabled, addPath);

	// 4) packages 的包内技能（npm 安装目录下的 skills/ 或 pi.skills 声明）
	collectPackageSkills(join(agentDir, "settings.json"), agentDir, isPiDeckEnabled, addPath);
	collectPackageSkills(join(cwd, ".pi", "settings.json"), cwd, isPiDeckEnabled, addPath);

	// 无任何禁用（settings ∪ frontmatter）→ 白名单关闭，pi 默认发现全部技能。
	if (disabledKeys.size === 0 && excluded.count === 0) {
		return null;
	}
	return paths;
}

export type SkillWhitelistResolverOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()（与 PiProcessOptions.agentHomeDir 语义一致）。 */
	agentHomeDir?: string;
	/** 会话项目根（pi 的 cwd），决定项目级 .pi/skills 与祖先 .agents/skills。 */
	cwd: string;
	/** PiDeck settings 中禁用的全局技能名（比较时小写）。 */
	disabledNames: string[];
};

/** 读取 frontmatter 中的技能名与 disable-model-invocation（与 SkillManager.parseFrontmatter 同规则）。 */
function readSkillMeta(skillFile: string): { name: string; modelInvocationDisabled: boolean } {
	try {
		const raw = readFileSync(skillFile, "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		const fields: Record<string, string> = {};
		if (match) {
			for (const line of match[1].split(/\r?\n/)) {
				const index = line.indexOf(":");
				if (index === -1) continue;
				const key = line.slice(0, index).trim();
				const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
				if (key) fields[key] = value;
			}
		}
		return {
			name: String(fields.name ?? "").trim(),
			modelInvocationDisabled: fields["disable-model-invocation"] === "true",
		};
	} catch {
		return { name: "", modelInvocationDisabled: false };
	}
}

/**
 * 技能文件是否应注入白名单：frontmatter 无 name（读不到，注入后由 pi 校验丢弃）视为
 * 未禁用；显式禁用列表（PiDeck settings ∪ 项目 settings）或 frontmatter 的
 * disable-model-invocation（老版 PiDeck 禁用语义，仅阻止自动调用）都排除——
 * 后者一并排除让旧禁用状态升级后直接变为「不加载」，无需用户重新操作。
 */
function isEnabledSkill(skillFile: string, disabledKeys: Set<string>): boolean {
	const { name, modelInvocationDisabled } = readSkillMeta(skillFile);
	if (modelInvocationDisabled) return false;
	return !name || !disabledKeys.has(name.toLowerCase());
}

/**
 * 扫描技能目录（规则与 pi 的 collectSkillEntries 对齐）：
 * 目录内存在 SKILL.md → 该目录整体是一个技能（即使被 ignore 也不递归，与 pi 一致）；
 * 否则递归子目录，顶层 .md 文件仅 pi 模式视为技能（agents 模式只认嵌套 .md）。
 * root 为扫描入口目录；ignore 规则从 root 起逐目录加载；override patterns 按作用域传入。
 */
function collectSkillDir(
	dir: string,
	mode: "pi" | "agents",
	isPiDeckEnabled: (skillFile: string) => boolean,
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
		return; // 目录不存在：无技能
	}
	const igRef = ig ?? ignore();
	addIgnoreRules(igRef, dir, root);

	for (const entry of entries) {
		if (entry.name !== SKILL_FILE) continue;
		const fullPath = join(dir, entry.name);
		if (!isFileEntry(entry, fullPath)) continue;
		if (igRef.ignores(toPosixPath(relative(root, fullPath)))) return;
		if (isPiDeckEnabled(fullPath) && passesOverrides(fullPath, overridesBase, overrides)) {
			addPath(fullPath);
		}
		return; // 有 SKILL.md 的目录不再递归，与 pi 一致
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

		if (isDirEntry(entry, fullPath)) {
			const relPath = toPosixPath(relative(root, fullPath));
			if (igRef.ignores(`${relPath}/`)) continue;
			collectSkillDir(fullPath, mode, isPiDeckEnabled, addPath, overridesBase, overrides, root, igRef);
			continue;
		}
		if (!isFileEntry(entry, fullPath)) continue;

		// 顶层 .md 根技能：pi 模式（~/.pi/agent/skills、.pi/skills）顶层算；
		// agents 模式（~/.agents/skills、.agents/skills）顶层忽略、嵌套才算
		const isRootLevel = dir === root;
		if (!entry.name.toLowerCase().endsWith(".md")) continue;
		if (!((mode === "pi" && isRootLevel) || (mode === "agents" && !isRootLevel))) continue;
		if (igRef.ignores(toPosixPath(relative(root, fullPath)))) continue;
		if (isPiDeckEnabled(fullPath) && passesOverrides(fullPath, overridesBase, overrides)) {
			addPath(fullPath);
		}
	}
}

/** 从 cwd 向上收集 .agents/skills 目录，到 git repo root（无仓库时到文件系统根）。 */
function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(dir);
	while (true) {
		dirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * settings.json skills 数组的显式路径（plain 条目）：文件直接注入，目录按 pi 模式递归枚举
 * （pi 的 collectFilesFromPaths → collectResourceFiles(dir, "skills") = collectSkillEntries(dir, "pi")，
 * 无 ignore）；整个显式集合再过 patterns（! + -）过滤。
 */
function collectSettingsSkills(
	base: string,
	plain: string[],
	patterns: string[],
	isPiDeckEnabled: (skillFile: string) => boolean,
	addPath: (path: string) => void,
): void {
	const allFiles: string[] = [];
	for (const rawPath of plain) {
		const resolved = resolveFromBase(rawPath, base);
		if (!resolved || !existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				allFiles.push(...collectSkillDirFiles(resolved, "pi"));
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

/** 枚举目录下全部技能文件（pi 模式，无 ignore——与 pi 的 collectResourceFiles 一致）。 */
function collectSkillDirFiles(dir: string, mode: "pi" | "agents"): string[] {
	const files: string[] = [];
	collectSkillDir(dir, mode, () => true, (path) => files.push(path), dir, []);
	return files;
}

/**
 * 枚举 npm 包内的技能（对齐 pi 的 collectPackageResources）：
 * 包内 skills/ 约定目录（collectSkillEntries(dir, "pi")）或 package.json 的 pi.skills 声明。
 * 对象条目 { source, skills, autoload } 的过滤语义：
 *   - skills 未定义 → 默认全加载（manifest 或约定目录）
 *   - skills 空数组 → 该包全部技能禁用
 *   - skills 非空 → applyPatterns（include/! /+/-）
 *   - autoload === false → delta 模式（只按 pattern 开关，默认全加载）
 * git:/github:/https: 源安装目录无法稳定推导，跳过（与 enabledExtensionResolver 同限制）。
 */
function collectPackageSkills(
	settingsFile: string,
	scopeBase: string,
	isPiDeckEnabled: (skillFile: string) => boolean,
	addPath: (path: string) => void,
): void {
	const settings = readSettingsObject(settingsFile);
	const packages = settings.packages;
	if (!Array.isArray(packages)) return;

	for (const entry of packages) {
		const filter = typeof entry === "object" && entry !== null
			? (entry as { source?: unknown; skills?: unknown; autoload?: unknown })
			: null;
		const source = typeof entry === "string" ? entry : filter?.source;
		if (typeof source !== "string" || !source) continue;

		const pkgDir = resolvePackageDir(source, scopeBase);
		if (!pkgDir) continue;

		// 包内技能全集：manifest pi.skills 声明（plain 条目，glob 条目跳过）或约定 skills/ 目录
		const manifestSkills = readManifestSkills(pkgDir);
		let allFiles: string[];
		if (manifestSkills) {
			allFiles = manifestSkills.files;
		} else {
			allFiles = collectSkillDirFiles(join(pkgDir, "skills"), "pi");
		}

		const skillsPatterns = Array.isArray(filter?.skills)
			? filter.skills.filter((item): item is string => typeof item === "string")
			: null;

		let files: string[];
		if (skillsPatterns === null) {
			// 无过滤：manifest patterns 已在 readManifestSkills 内过滤
			files = allFiles;
		} else if (filter?.autoload === false) {
			// delta：默认全加载，只按 pattern 开关（+/-精确、普通/! glob）
			files = allFiles.filter((f) => deltaEnabled(f, skillsPatterns, pkgDir));
		} else if (skillsPatterns.length === 0) {
			// 空数组显式禁用该包全部技能（pi 的 applyPackageFilter 语义）
			files = [];
		} else {
			const enabledSet = applyPatterns(allFiles, skillsPatterns, pkgDir);
			files = allFiles.filter((f) => enabledSet.has(f));
		}

		for (const file of files) {
			if (isPiDeckEnabled(file)) addPath(file);
		}
	}
}

/** 解析 packages 条目的安装目录（npm: 推导 node_modules 路径；file:/裸路径按 base 解析）。 */
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
 * 读取包的 pi.skills manifest：plain 条目展开成文件集合（文件直接、目录按 pi 模式递归），
 * `!`/`+`/`-` 前缀条目按 applyPatterns 过滤（对齐 pi 的 collectManifestFiles/addManifestEntries）。
 * 含 glob 的 plain 条目跳过（已知限制）。无声明返回 null（调用方 fallback 约定目录）。
 */
function readManifestSkills(pkgDir: string): { files: string[] } | null {
	let pkg: { pi?: { skills?: string[] } };
	try {
		pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
			pi?: { skills?: string[] };
		};
	} catch {
		return null; // package.json 缺失/损坏
	}
	const entries = pkg.pi?.skills;
	if (!Array.isArray(entries) || entries.length === 0) return null;

	const { plain, patterns } = splitResourceEntries(entries);
	const allFiles: string[] = [];
	for (const raw of plain) {
		if (raw.includes("*") || raw.includes("?")) continue; // glob 条目：已知限制跳过
		const resolved = resolve(join(pkgDir, raw));
		if (!existsSync(resolved)) continue;
		try {
			if (statSync(resolved).isDirectory()) {
				allFiles.push(...collectSkillDirFiles(resolved, "pi"));
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
