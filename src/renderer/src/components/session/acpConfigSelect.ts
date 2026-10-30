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
import type { AcpModelRate, AcpSessionConfigOption } from "../../../../shared/types/acp";

export type AcpConfigSelectValue = { value: string; name: string /** agent 给的次级说明（权限档说明等），列表项里以弱化小字展示。 */; description?: string /** magpie 本地倍率（主进程注解，非 ACP wire 字段）。 */; rate?: AcpModelRate /** 当前值不在枚举里时补的占位项（再点选等价于不变）。 */; current?: boolean };

export type AcpConfigSelectModel = { value: string; label: string; values: AcpConfigSelectValue[] };

export type AcpConfigEntry = { option: AcpSessionConfigOption; values: Array<{ value: string; name: string; description?: string; rate?: AcpModelRate }> };

/** 平铺 configOptions 的取值枚举（group 结构展平）。boolean 项保留（values 为空），由渲染层走开关分支。 */
export function flattenAcpConfigOptions(options: ReadonlyArray<AcpSessionConfigOption>): AcpConfigEntry[] {
	const result: AcpConfigEntry[] = [];
	for (const option of options) {
		const values: Array<{ value: string; name: string; description?: string; rate?: AcpModelRate }> = [];
		for (const item of option.options ?? []) {
			if ("group" in item) {
				// description/rate 属于具体取值（组名只是分类），不要被组名前缀挤掉。
				for (const inner of item.options) {
					values.push({
						value: inner.value,
						name: item.name ? `${item.name} / ${inner.name}` : inner.name,
						...(inner.description ? { description: inner.description } : {}),
						...(inner.rate ? { rate: inner.rate } : {}),
					});
				}
			} else {
				values.push({ value: item.value, name: item.name, ...(item.description ? { description: item.description } : {}), ...(item.rate ? { rate: item.rate } : {}) });
			}
		}
		result.push({ option, values });
	}
	return result;
}

/**
 * 是否渲染成底栏控件：boolean 恒显示（开关）；
 * select 至少两个候选才显示——单值 select（如 CodeBuddy 2.178.1 的 agent=cli）点不动也无处可写，
 * 留在底栏只是一个必然报错的死 chip。
 */
export function isRenderableAcpConfigEntry(entry: AcpConfigEntry): boolean {
	return entry.option.type === "boolean" || entry.values.length > 1;
}

export function resolveAcpConfigSelect(option: AcpSessionConfigOption, values: ReadonlyArray<{ value: string; name: string; description?: string; rate?: AcpModelRate }>): AcpConfigSelectModel {
	const raw = option.currentValue === undefined ? "" : String(option.currentValue);
	const matched = raw ? values.find((value) => value.value === raw) : undefined;
	// 无当前值时沿用旧行为：触发器显示选项名（如「Model」），下拉不高亮任何项。
	const label = matched?.name ?? (raw || option.name);
	if (!raw || matched) return { value: raw, label, values: values.map((value) => ({ ...value })) };
	return { value: raw, label, values: [{ value: raw, name: label, current: true }, ...values.map((value) => ({ ...value }))] };
}
