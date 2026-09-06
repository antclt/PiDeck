/**
 * 提供商显示开关的纯函数（Pi 模型页隐藏过滤）。
 * 隐藏语义：配置本身保留（models.json 不动），仅从模型页主列表与模型选择器过滤；
 * 恢复显示 = 从 hiddenProviders 移除该 key。
 */

/** 按隐藏列表拆分供应商名：visible = 主列表展示，hidden = 底部「已隐藏」折叠区。 */
export function splitVisibleAndHiddenProviders(
	providerNames: string[],
	hiddenProviders: string[],
): { visible: string[]; hidden: string[] } {
	const hiddenSet = new Set(hiddenProviders);
	const visible: string[] = [];
	const hidden: string[] = [];
	for (const name of providerNames) {
		if (hiddenSet.has(name)) hidden.push(name);
		else visible.push(name);
	}
	return { visible, hidden };
}

/** 切换单个供应商的隐藏状态：已隐藏则恢复，未隐藏则加入。 */
export function toggleHiddenProvider(
	hiddenProviders: string[],
	name: string,
): string[] {
	return hiddenProviders.includes(name)
		? hiddenProviders.filter((item) => item !== name)
		: [...hiddenProviders, name];
}

/** 按隐藏列表过滤模型列表（模型选择器用；DSH 后端不参与过滤，由调用方决定传不传）。 */
export function filterModelsByHiddenProviders<T extends { provider: string }>(
	models: T[],
	hiddenProviders: string[],
): T[] {
	if (hiddenProviders.length === 0) return models;
	const hiddenSet = new Set(hiddenProviders);
	return models.filter((model) => !hiddenSet.has(model.provider));
}
