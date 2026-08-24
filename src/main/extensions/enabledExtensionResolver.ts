import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { DisabledExtensionEntry } from "../../shared/types";
import {
	listActiveBuiltInExtensionPaths,
	type BuiltInExtensionPathRoots,
} from "./builtInExtensions";

/** pi 的配置目录名（项目级 .pi / 全局 .pi/agent）。 */
const CONFIG_DIR_NAME = ".pi";

export type EnabledExtensionResolverOptions = {
	/** WSL 场景传入 Windows 侧 home；缺省 homedir()（与 PiProcessOptions.agentHomeDir 语义一致）。 */
	agentHomeDir?: string;
	/** 会话项目根（pi 的 cwd），决定项目级 packages 与 .pi/extensions 目录。 */
	cwd: string;
	/** PiDeck settings 中的禁用条目（scope+source）。 */
	disabled: DisabledExtensionEntry[];
	/** 已移除的内置扩展（独立机制，不参与 disabled 列表）。 */
	removedBuiltInExtensions: readonly string[];
	/** 内置扩展资源根（dev: appPath/resources/extensions；打包: resourcesPath/extensions）。 */
	builtInRoots: BuiltInExtensionPathRoots;
};

/**
 * 白名单模式解析器：计算 RPC 启动时应通过 --extension/-e 注入的扩展路径。
 *
 * 为什么需要它：pi 0.82.x 的 settings.json 不支持 disabledExtensions（写了也忽略），
 * 唯一可靠的禁用手段是 `--no-extensions`（关自动发现）+ 显式 -e 白名单。
 * 但 -ne 下 pi 连 npm packages 和本地目录扩展都不发现，所以启用白名单时 PiDeck
 * 必须把「pi 本来会加载的全部扩展」自己枚举出来，剔除禁用项后逐条注入。
 *
 * 枚举源与 pi 0.82 的 DefaultPackageManager.resolve() 对齐：
 *   1. user/project settings.json 的 packages（npm 包按安装目录推导）
 *   2. ~/.pi/agent/extensions 与 <cwd>/.pi/extensions 的本地扩展（.ts/.js 文件 + 含入口的目录）
 *   3. PiDeck 内置扩展（app resources）
 *
 * 返回 null = 无禁用项，白名单关闭（pi 自动发现，兼容 PiDeck 未跟踪的手动安装）；
 * 返回数组（可能为空）= 白名单开启，调用方需同时传 --no-extensions。
 */
export function resolveEnabledExtensionPaths(
	options: EnabledExtensionResolverOptions,
): string[] | null {
	const { disabled, cwd } = options;
	if (disabled.length === 0) return null;

	const agentDir = join(options.agentHomeDir?.trim() || homedir(), CONFIG_DIR_NAME, "agent");
	// scope+source 联合去重：同一 source 可在 user/project 两级独立禁用
	const disabledKeys = new Set(disabled.map((entry) => `${entry.scope}:${entry.source.trim()}`));
	const isEnabled = (scope: DisabledExtensionEntry["scope"], source: string) =>
		!disabledKeys.has(`${scope}:${source.trim()}`);

	const paths: string[] = [];
	const seen = new Set<string>();
	const addPath = (path: string) => {
		if (!path || seen.has(path)) return;
		seen.add(path);
		paths.push(path);
	};

	// 1) packages：user 级读 ~/.pi/agent/settings.json，project 级读 <cwd>/.pi/settings.json
	collectPackages(join(agentDir, "settings.json"), "user", agentDir, cwd, isEnabled, addPath);
	collectPackages(join(cwd, CONFIG_DIR_NAME, "settings.json"), "project", agentDir, cwd, isEnabled, addPath);

	// 2) 本地扩展目录：用户级 + 项目级（与 pi 的 collectAutoExtensionEntries 同规则）
	collectLocalExtensions(join(agentDir, "extensions"), "user", isEnabled, addPath);
	collectLocalExtensions(join(cwd, CONFIG_DIR_NAME, "extensions"), "project", isEnabled, addPath);

	// 3) 内置扩展：以 -e 从 app resources 注入，removedBuiltInExtensions 已剔除
	for (const path of listActiveBuiltInExtensionPaths(options.builtInRoots, options.removedBuiltInExtensions)) {
		addPath(path);
	}

	return paths;
}

/** 解析 settings.json 的 packages 数组（字符串或 {source, ...} 对象），把启用的包注入白名单。 */
function collectPackages(
	settingsFile: string,
	scope: DisabledExtensionEntry["scope"],
	agentDir: string,
	cwd: string,
	isEnabled: (scope: DisabledExtensionEntry["scope"], source: string) => boolean,
	addPath: (path: string) => void,
): void {
	const packages = readConfiguredPackages(settingsFile);
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : (entry as { source?: string } | null)?.source;
		if (!source || !isEnabled(scope, source)) continue;

		if (source.startsWith("npm:")) {
			// npm 包安装目录：project 为 <cwd>/.pi/npm/node_modules/<name>，user 为 ~/.pi/agent/npm/node_modules/<name>。
			// 与 pi 的 getNpmInstallPath 一致；仅注入已存在的目录，未安装（或安装中）跳过——
			// -e 指向不存在的路径 pi 会报 "Extension path does not exist"。
			const name = source.slice(4).trim();
			if (!name) continue;
			const root = scope === "project" ? join(cwd, CONFIG_DIR_NAME, "npm") : join(agentDir, "npm");
			const candidate = join(root, "node_modules", name);
			if (existsSync(candidate)) addPath(candidate);
			continue;
		}

		if (source.startsWith("file:") || !/^(?:npm|git|github|https?):/i.test(source)) {
			// 本地文件/目录源：相对路径相对作用域 base 解析（与 pi getBaseDirForScope 一致）。
			// 裸路径（无协议前缀）在 pi 中同样按本地源处理。
			const rawPath = source.startsWith("file:") ? source.slice(5) : source;
			const base = scope === "project" ? join(cwd, CONFIG_DIR_NAME) : agentDir;
			const candidate = resolveFromBase(rawPath, base);
			if (candidate && existsSync(candidate)) addPath(candidate);
			continue;
		}

		// git:/github:/https: 源的安装目录含规范化后的仓库路径，无法稳定推导；
		// 命中即记录 debug 提示（保留 addPath 语义），避免白名单静默漏载这类罕见源。
		// 已知限制：这些源在用户禁用任意扩展后不会随白名单加载。
	}
}

/** 读取 settings.json 的 packages 数组；文件缺失/损坏返回空数组。 */
function readConfiguredPackages(settingsFile: string): unknown[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const packages = (parsed as Record<string, unknown>).packages;
		return Array.isArray(packages) ? packages : [];
	} catch {
		return []; // 无 settings.json 或解析失败：该作用域没有已配置包
	}
}

/**
 * 扫描扩展目录（用户/项目各一次）。规则与 pi 的 collectAutoExtensionEntries 对齐：
 * 顶层 *.ts/*.js 文件直接是扩展；子目录需含入口（package.json 的 pi.extensions 或 index.ts/index.js）。
 * 返回与 pi 一致的「入口文件路径」（而非目录），与 loader 的 import 语义保持一致。
 */
function collectLocalExtensions(
	dir: string,
	scope: DisabledExtensionEntry["scope"],
	isEnabled: (scope: DisabledExtensionEntry["scope"], source: string) => boolean,
	addPath: (path: string) => void,
): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // 目录不存在：无本地扩展
	}
	for (const entry of entries) {
		const name = entry.name;
		if (name.startsWith(".") || name === "node_modules" || name.endsWith(".d.ts")) continue;
		const fullPath = join(dir, name);

		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = statSync(fullPath).isDirectory();
			} catch {
				continue; // 悬空链接：pi 同样跳过
			}
		}

		if (!isDir) {
			if ((name.endsWith(".ts") || name.endsWith(".js")) && isEnabled(scope, name)) {
				addPath(fullPath);
			}
			continue;
		}

		const entryFiles = resolveExtensionEntryPoints(fullPath);
		if (entryFiles && isEnabled(scope, name)) {
			for (const file of entryFiles) addPath(file);
		}
	}
}

/**
 * 目录的扩展入口（与 pi loader.resolveExtensionEntries 同规则）：
 * 1. package.json 含 "pi.extensions" 字段 → 声明路径（必须存在）
 * 2. index.ts / index.js → 入口文件
 * 无入口返回 null。
 */
function resolveExtensionEntryPoints(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { pi?: { extensions?: string[] } };
			const declared = pkg.pi?.extensions;
			if (Array.isArray(declared) && declared.length > 0) {
				const resolved = declared
					.map((rel) => join(dir, rel))
					.filter((path) => existsSync(path));
				if (resolved.length > 0) return resolved;
			}
		} catch {
			// package.json 损坏：降级走 index 检查
		}
	}
	for (const index of ["index.ts", "index.js"]) {
		const indexPath = join(dir, index);
		if (existsSync(indexPath)) return [indexPath];
	}
	return null;
}

/**
 * 按 pi 的 resolvePath 语义解析本地源路径：支持绝对路径、~（家目录）与相对作用域 base。
 * 解析失败返回 null（调用方跳过该源）。
 */
function resolveFromBase(input: string, base: string): string | null {
	const trimmed = input.replace(/^["']|["']$/g, "").trim();
	if (!trimmed) return null;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return join(homedir(), trimmed.slice(2));
	}
	if (isAbsolute(trimmed)) return normalize(trimmed);
	return resolve(base, trimmed);
}