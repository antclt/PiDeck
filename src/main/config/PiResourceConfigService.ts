/**
 * pi 原生资源配置服务（计划 A2/A3/A4 的服务层）。
 *
 * 职责边界：
 * - 只管理 pi settings.json 的 `extensions/skills/prompts/themes` 与 `packages` 条目，
 *   不管理扩展运行、不 spawn pi、不解析 MCP（那是各自模块的职责）。
 * - 作用域固定：全局 = 当前 agentDir/settings.json；项目 = 项目 `.pi/settings.json`
 *  （经注册 projectId 与信任门禁）。
 * - 所有写入走 `writePiConfigFile`：锁内重读 → 只改目标条目 → 原子写。
 *
 * 运行时真值仍是 pi：本服务提供的「有效状态」是配置投影（供列表展示与预检），
 * 不冒充已加载状态（见计划 3.3）。
 */

import { join } from "node:path";
import type { PiBuiltinExtension, PiBuiltinExtensionState, PiFileResourceToggleRequest, PiPackageToggleRequest, PiResourceConfigSummary, PiResourceKind, PiResourceScope, PiResourceToggleResult } from "../../shared/types/piResources";
import { PI_BUILTIN_EXTENSIONS, PI_RESOURCE_KINDS } from "../../shared/types/piResources";
import { readPiConfigFile, readStringArraySetting, writePiConfigFile } from "./piConfigFileStore";
import { disablePackageDeltaFilters, disablePackageFilters, enablePackageDeltaFilters, isPackageDeltaFullyDisabled, isPackageFullyDisabled, resolveBuiltinExtensionState, setBuiltinExtensionEnabled, setResourceRuleEnabled, stripExactResourceRules } from "./piResourceRules";
import type { PackageFilterSnapshot } from "./piResourceRules";
import { PiResourceStateStore } from "./PiResourceStateStore";

export type PiResourceEnvironmentResolver = {
	/** 当前全局 settings.json 路径（已处理 WSL 映射）。 */
	globalSettingsPath: () => string;
	/** 项目 runtime 路径 + 信任判定；未注册/未信任返回 null。 */
	resolveProject: (projectId: string) => Promise<{ root: string; trusted: boolean } | null>;
};

type ProjectTrustGate = (projectId: string, root: string) => Promise<boolean>;

export class PiResourceConfigService {
	constructor(
		private readonly environment: PiResourceEnvironmentResolver,
		private readonly state: PiResourceStateStore,
		private readonly options: { projectTrust?: ProjectTrustGate } = {},
	) {}

	/** 解析作用域对应的 settings.json 路径；项目未注册/未信任时抛错（不能偷偷读写）。 */
	async resolveSettingsPath(scope: PiResourceScope, options: { requireTrust?: boolean } = {}): Promise<string> {
		if (scope.scope === "global") return this.environment.globalSettingsPath();
		const resolved = await this.environment.resolveProject(scope.projectId);
		if (!resolved) throw new Error("Project not found.");
		if (options.requireTrust !== false && !resolved.trusted) throw new Error("Project is not trusted.");
		return join(resolved.root, ".pi", "settings.json");
	}

	/** 读取某作用域的原生配置摘要（含内置扩展开关状态，含项目继承层）。 */
	async readSummary(scope: PiResourceScope): Promise<PiResourceConfigSummary> {
		const settingsPath = await this.resolveSettingsPath(scope, { requireTrust: scope.scope === "global" ? false : true });
		const file = await readPiConfigFile(settingsPath);
		let baseEntries: string[] | undefined;
		if (scope.scope === "project") {
			// 项目内置扩展开关要按两层合并语义计算（项目 `+builtin:` 覆盖全局 `-builtin:`）。
			const global = await readPiConfigFile(this.environment.globalSettingsPath());
			if (!global.error) baseEntries = readStringArraySetting(global.data, "extensions");
		}
		const entries = readStringArraySetting(file.data, "extensions");
		const builtins: PiBuiltinExtensionState[] = PI_BUILTIN_EXTENSIONS.map((name) => {
			const state = resolveBuiltinExtensionState({ baseEntries, entries, name });
			return {
				name,
				enabled: state.enabled,
				explicitInLayer: state.explicitInLayer,
				state: state.explicitInLayer ? (state.enabled ? "explicit-enabled" : "explicit-disabled") : "inherit",
			};
		});
		return {
			settingsPath,
			exists: file.exists,
			...(file.error ? { error: file.error } : {}),
			revision: file.revision,
			builtins,
			entries: {
				extensions: entries,
				skills: readStringArraySetting(file.data, "skills"),
				prompts: readStringArraySetting(file.data, "prompts"),
				themes: readStringArraySetting(file.data, "themes"),
			},
		};
	}

	/** 切换某个 pi 原生内置扩展在本层的开关。 */
	async setBuiltinEnabled(scope: PiResourceScope, name: PiBuiltinExtension, enabled: boolean, options: { expectedRevision?: string } = {}): Promise<PiResourceToggleResult> {
		if (!PI_BUILTIN_EXTENSIONS.includes(name)) return { ok: false, error: `Unknown built-in extension: ${name}` };
		return this.writeScope(scope, options.expectedRevision, (current) => ({
			...current,
			extensions: setBuiltinExtensionEnabled({ entries: readStringArraySetting(current, "extensions"), name, enabled }),
		}));
	}

	/** 切换一个独立文件/目录资源（按值精确规则，不删用户显式路径与 glob）。 */
	async setFileResourceEnabled(request: PiFileResourceToggleRequest, options: { expectedRevision?: string } = {}): Promise<PiResourceToggleResult> {
		const value = request.resourceId;
		if (typeof value !== "string" || !value.trim()) return { ok: false, error: "Resource identifier is required." };
		return this.writeScope(request.scope, options.expectedRevision, (current) => ({
			...current,
			[request.kind]: setResourceRuleEnabled({ entries: readStringArraySetting(current, request.kind), value, enabled: request.enabled }),
		}));
	}

	/**
	 * 开关一个扩展（全局/项目）。
	 *
	 * 分派规则与 pi 一致：
	 * - 包安装（`npm:`/`file:`/`git…`/`github:` 等 source 协议）→ 整包过滤
	 *   （普通包写四类 `[]` / 恢复快照；`autoload:false` delta 用 `["!*","!.*"]`）。
	 * - 本地文件扩展（`~/.pi/agent/extensions` 下自动发现）→ 顶层精确 `+path` / `-path`。
	 */
	async setExtensionEnabled(input: { scope: PiResourceScope; source: string; path?: string; enabled: boolean }, options: { expectedRevision?: string } = {}): Promise<PiResourceToggleResult> {
		const source = input.source.trim();
		if (!source) return { ok: false, error: "Extension source is required." };
		if (isPackageSource(source)) {
			return this.setPackageEnabled({ scope: input.scope, resourceId: source, enabled: input.enabled }, options);
		}
		// 本地文件扩展：优先用真实磁盘路径（pi 的精确匹配按绝对路径 / baseDir 相对路径）。
		const value = input.path?.trim() || source;
		return this.setFileResourceEnabled({ scope: input.scope, kind: "extensions", resourceId: value, enabled: input.enabled }, options);
	}

	/**
	 * 在项目层覆盖一个「继承自全局」的资源（扩展/技能/提示词）。
	 *
	 * 与 pi `config-selector` 的项目覆盖写法一致：写入该资源的**绝对路径**（plain 声明，
	 * 否则项目层匹配不到全局文件），再配精确 `+path`/`-path`。恢复继承时移除本次写入的
	 * plain 路径与精确规则（不删用户原有的其它引用）。
	 */
	async setProjectInheritedOverride(
		input: {
			projectId: string;
			kind: Exclude<PiResourceKind, "themes">;
			/** 继承资源在 pi 里的路径（绝对路径）。 */
			value: string;
			/** "inherit" = 移除覆盖；true/false = 在本层启用/停用。 */
			state: "inherit" | "enabled" | "disabled";
		},
		options: { expectedRevision?: string } = {},
	): Promise<PiResourceToggleResult> {
		const value = input.value.trim();
		if (!value) return { ok: false, error: "Resource path is required." };
		return this.writeScope({ scope: "project", projectId: input.projectId }, options.expectedRevision, (current) => {
			const entries = readStringArraySetting(current, input.kind);
			const withoutOurRules = entries.filter((entry) => !isExactEntryFor(entry, value));
			if (input.state === "inherit") {
				// 恢复继承：只移除我们写的精确规则；plain 路径若为用户原有引用则保留。
				return { ...current, [input.kind]: withoutOurRules };
			}
			// plain 路径声明：项目层要匹配跨作用域的全局文件时必须显式列出该路径，
			// 否则精确 `+`/`-` 找不到目标（pi config-selector 的项目覆盖同样先写路径）。
			const plain = value;
			const rest = withoutOurRules.filter((entry) => entry !== value);
			const next = input.state === "enabled" ? `+${value}` : `-${value}`;
			return { ...current, [input.kind]: [plain, next, ...rest] };
		});
	}

	/** 恢复某资源的默认（删除 PiDeck 加的精确覆盖规则，保留用户显式路径）。 */
	async clearFileResourceOverride(scope: PiResourceScope, kind: PiResourceKind, value: string, options: { expectedRevision?: string } = {}): Promise<PiResourceToggleResult> {
		return this.writeScope(scope, options.expectedRevision, (current) => ({
			...current,
			[kind]: stripExactResourceRules(readStringArraySetting(current, kind), value),
		}));
	}

	/**
	 * 包整体启停。
	 * - 普通包条目：四类过滤写 `[]`；停用前保存快照，启用时若当前仍等于快照结果则恢复原过滤。
	 * - `autoload:false` 的项目 delta：用 `["!*","!.*"]` / `["*",".*"]`（delta 空数组是「不覆盖」）。
	 */
	async setPackageEnabled(request: PiPackageToggleRequest, options: { expectedRevision?: string } = {}): Promise<PiResourceToggleResult> {
		const settingsPath = await this.resolveSettingsPath(request.scope, { requireTrust: true });
		const snapshotKey = this.state.packageKey(settingsPath, request.resourceId);
		// 停用前先保存恢复快照（幂等：已有快照不覆盖）。
		if (!request.enabled) {
			const file = await readPiConfigFile(settingsPath);
			if (file.error) return { ok: false, error: file.error };
			const entry = findPackageEntry(file.data, request.resourceId);
			if (!entry) return { ok: false, error: "Package not found in this scope." };
			if (!isEntryDisabled(entry)) this.state.savePackageSnapshot(snapshotKey, packageFilterSnapshot(entry));
		}
		const result = await this.writeScope(request.scope, options.expectedRevision, (current) => {
			const packages = Array.isArray(current.packages) ? [...current.packages] : [];
			const index = packages.findIndex((entry) => packageSourceOf(entry) === request.resourceId);
			if (index === -1) return { abort: "Package not found in this scope." };
			const entry = packages[index];
			if (!entry || typeof entry !== "object") return { abort: "Package entry is invalid." };
			if (isPackageDelta(entry)) {
				packages[index] = request.enabled ? enablePackageDeltaFilters(entry as { source: string }) : disablePackageDeltaFilters(entry as { source: string });
			} else if (request.enabled) {
				// 只有「当前状态仍等于停用后指纹」时才恢复快照；否则视为外部已改过，明确回到包默认。
				const snapshot = this.state.isPackageSnapshotCurrent(snapshotKey, entry) ? this.state.takePackageSnapshot(snapshotKey) : undefined;
				packages[index] = snapshot ? { ...restorePackageDefaults(entry as Record<string, unknown>), ...snapshot } : restorePackageDefaults(entry as Record<string, unknown>);
			} else {
				packages[index] = disablePackageFilters(entry as { source: string });
			}
			return { ...current, packages };
		});
		if (result.ok) {
			if (request.enabled) {
				this.state.clearPackageSnapshot(snapshotKey);
			} else {
				// 停用成功后记录 after 指纹：之后只有条目仍等于它才允许自动恢复原过滤。
				const written = await this.readSettingsEntry(settingsPath, request.resourceId);
				this.state.markPackageSnapshotAfter(snapshotKey, written);
			}
		}
		return { ok: result.ok, ...(result.ok ? {} : { error: result.error }), ...(result.revision ? { revision: result.revision } : {}) };
	}

	/** 读回某个包条目（停用后记录指纹用）。 */
	private async readSettingsEntry(settingsPath: string, source: string): Promise<unknown> {
		const file = await readPiConfigFile(settingsPath);
		return findPackageEntry(file.data, source);
	}

	/** 内部：写一个作用域并统一返回结果形状。 */
	private async writeScope(scope: PiResourceScope, expectedRevision: string | undefined, mutate: (current: Record<string, unknown>) => Record<string, unknown> | { abort: string }): Promise<PiResourceToggleResult> {
		const settingsPath = await this.resolveSettingsPathSafely(scope);
		if (!settingsPath) return { ok: false, error: "Project is not available or not trusted." };
		const result = await writePiConfigFile(settingsPath, mutate, {
			expectedRevision,
			precheck: async () => {
				if (!(await this.projectTrustPrecheck(scope))) throw new Error("Project is not trusted.");
			},
		});
		return { ok: result.ok, ...(result.ok ? {} : { error: result.error }), ...(result.revision ? { revision: result.revision } : {}) };
	}

	/** 解析失败（项目不存在/未信任）返回 null，由调用方转成统一错误结果。 */
	private async resolveSettingsPathSafely(scope: PiResourceScope): Promise<string | null> {
		try {
			return await this.resolveSettingsPath(scope, { requireTrust: true });
		} catch {
			return null;
		}
	}

	/** 项目作用域在真正写入前再校验一次信任（信任是安全边界，不能只信渲染层）。 */
	private async projectTrustPrecheck(scope: PiResourceScope): Promise<boolean> {
		if (scope.scope === "global") return true;
		if (!this.options.projectTrust) return false;
		const resolved = await this.environment.resolveProject(scope.projectId);
		if (!resolved) return false;
		return this.options.projectTrust(scope.projectId, resolved.root);
	}
}

// ── 辅助（纯函数，便于测试） ─────────────────────────────

/** 包安装 source 的协议前缀（与 pi list 输出的 source 形态一致）。 */
export function isPackageSource(source: string): boolean {
	return /^(?:npm|file|github|git|https?):/i.test(source.trim());
}

/** 条目是否精确指向该值（带 `+`/`-` 前缀时比较去掉前缀后的值）。 */
export function isExactEntryFor(entry: string, value: string): boolean {
	const bare = entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!") ? entry.slice(1) : entry;
	return bare === value;
}

// ── 包条目辅助（纯函数，便于测试） ─────────────────────────────

export function packageSourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { source?: unknown }).source === "string") {
		return (entry as { source: string }).source;
	}
	return undefined;
}

export function findPackageEntry(data: Record<string, unknown>, source: string): unknown {
	if (!Array.isArray(data.packages)) return undefined;
	return data.packages.find((entry) => packageSourceOf(entry) === source);
}

/** `autoload:false` 的项目 delta：过滤语义与普通包不同（空数组 = 不覆盖）。 */
export function isPackageDelta(entry: unknown): boolean {
	return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { autoload?: unknown }).autoload === false);
}

/** 某个包条目当前是否处于「整包停用」形状。 */
export function isEntryDisabled(entry: unknown): boolean {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	const shape = entry as Record<string, unknown>;
	return isPackageDelta(entry) ? isPackageDeltaFullyDisabled(shape) : isPackageFullyDisabled(shape);
}

/** 抽取包条目的四类过滤（用于停用前快照）。 */
export function packageFilterSnapshot(entry: unknown): PackageFilterSnapshot {
	const shape = (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
	const snapshot: PackageFilterSnapshot = {};
	for (const kind of PI_RESOURCE_KINDS) {
		const value = shape[kind];
		if (Array.isArray(value) && value.every((item) => typeof item === "string")) snapshot[kind] = [...(value as string[])];
	}
	return snapshot;
}

/** 启用一个没有快照的普通包：删掉四类过滤键，回到包 manifest 默认（明确动作，不是静默强开）。 */
export function restorePackageDefaults(entry: Record<string, unknown>): Record<string, unknown> {
	const next = { ...entry };
	for (const kind of PI_RESOURCE_KINDS) delete next[kind];
	return next;
}
