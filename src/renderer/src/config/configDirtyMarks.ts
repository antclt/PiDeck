import type { ConfigTab } from "./configTypes";
import { deepEqual } from "../utils/deepEqual";

/** 脏标记 key：与 ConfigModal 的 sectionTabValue 编码一致（"config:<tab>" 或 section 名）。 */
export type ConfigDirtyKey = `config:${ConfigTab}` | "skills" | "prompts";

/**
 * loadConfig(target) 会把磁盘数据写回内存 state，被覆盖数据对应的「未保存修改」已不成立，
 * 必须同步清除脏标记，否则会出现：保存后黄点残留、关闭时误弹「未保存」确认（用户反馈的假脏标记）。
 * 规则：
 * - 目标 tab 自身必然重载；
 * - rawContent 在任何分支都会被重写（raw 编辑器内存内容随之丢失）；
 * - settings 聚合页还会顺带重载 models/auth 的内存数据（同样被丢弃）。
 */
export function dirtyKeysClearedByReload(target: ConfigTab): ConfigDirtyKey[] {
	const keys = new Set<ConfigDirtyKey>([`config:${target}`, "config:raw"]);
	if (target === "settings") {
		keys.add("config:models");
		keys.add("config:auth");
	}
	return [...keys];
}

/**
 * 切 tab 触发的 loadConfig 若覆盖了仍有未保存草稿的内存，用户会看到「改完一切就没了」。
 * 返回本次重载里必须跳过写回的脏 key（调用方对它们既不 setState 也不 clearDirty）。
 */
export function dirtyKeysPreservedOnReload(
	target: ConfigTab,
	dirtyTabs: Iterable<string>,
): Set<ConfigDirtyKey> {
	const dirty = new Set(dirtyTabs);
	const preserved = new Set<ConfigDirtyKey>();
	for (const key of dirtyKeysClearedByReload(target)) {
		if (dirty.has(key)) preserved.add(key);
	}
	return preserved;
}

/** 配置导入会整体替换 models/auth/settings/trust 四个文件，需清掉全部 config 组脏标记（skills/prompts 编辑不涉及配置文件，保留）。 */
export const ALL_CONFIG_DIRTY_KEYS: readonly ConfigDirtyKey[] = [
	"config:models",
	"config:auth",
	"config:settings",
	"config:trust",
	"config:mcp",
	"config:raw",
];

/**
 * 按基准快照核算单条 Pi 配置脏标记（纯函数，可单测）。
 * 当前数据与基准相等则移除 key，否则加入——取代「改了就 markDirty」的 touched 语义，
 * 改回原值后脏标记自动消失，顶部保存按钮 / 左侧黄点 / 关闭确认只反映真实未保存改动。
 */
export function reconcileConfigDirty(
	keys: Set<string>,
	dirtyKey: string,
	current: unknown,
	baseline: unknown,
): void {
	if (deepEqual(current, baseline)) keys.delete(dirtyKey);
	else keys.add(dirtyKey);
}
