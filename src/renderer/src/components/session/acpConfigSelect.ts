/**
 * ACP configOptions → 下拉选择器的展示模型（纯函数，可单测）。
 *
 * 为什么需要它：agent 回传的 currentValue 不一定出现在它自己的 options 里
 * （典型：Claude ACP 的模型项 currentValue 是完整模型 id，而 options 只有别名）。
 * Radix Select 只在 value 能命中某个 item 时才高亮并滚动到该项；命不中就会：
 * 1) 触发器只能回退显示原始 id（长、截断后看不出是哪个模型）；
 * 2) 下拉打开停在第 0 项、没有勾选、也不滚到当前模型。
 * 这里补一条「当前值」项，让选中/滚动语义成立，同时不改动 agent 给的枚举
 * （再次点选它由调用方按同值忽略，不产生 IPC）。
 */
import type { AcpSessionConfigOption } from "../../../../shared/types/acp";

export type AcpConfigSelectValue = { value: string; name: string /** 当前值不在枚举里时补的占位项（再点选等价于不变）。 */; current?: boolean };

export type AcpConfigSelectModel = { value: string; label: string; values: AcpConfigSelectValue[] };

export function resolveAcpConfigSelect(option: AcpSessionConfigOption, values: ReadonlyArray<{ value: string; name: string }>): AcpConfigSelectModel {
	const raw = option.currentValue === undefined ? "" : String(option.currentValue);
	const matched = raw ? values.find((value) => value.value === raw) : undefined;
	// 无当前值时沿用旧行为：触发器显示选项名（如「Model」），下拉不高亮任何项。
	const label = matched?.name ?? (raw || option.name);
	if (!raw || matched) return { value: raw, label, values: values.map((value) => ({ ...value })) };
	return { value: raw, label, values: [{ value: raw, name: label, current: true }, ...values.map((value) => ({ ...value }))] };
}
