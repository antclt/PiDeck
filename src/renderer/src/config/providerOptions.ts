/**
 * 默认供应商下拉的候选聚合（纯函数，可单测）。
 *
 * 来源必须覆盖三处：模型配置（models.json providers）、认证条目（auth keys）、
 * 自动发现（auth-only 供应商通过端点探测，discoveredModels）。
 * 漏掉 discovered 会导致这类供应商在默认供应商下拉里「无匹配选项」、
 * 无法切换，且默认模型的联动过滤随之失效（模型切换列表三源齐全，两边不一致）。
 */
import type { AuthFile, ModelsFile } from "./configTypes";

export function collectProviderOptions(
	modelsData?: ModelsFile,
	authData?: AuthFile,
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>,
): Array<{ value: string }> {
	const providerSet = new Set<string>();
	if (modelsData) {
		for (const name of Object.keys(modelsData.providers)) {
			providerSet.add(name);
		}
	}
	if (authData) {
		for (const name of Object.keys(authData)) {
			providerSet.add(name);
		}
	}
	if (discoveredModels) {
		for (const name of Object.keys(discoveredModels)) {
			providerSet.add(name);
		}
	}
	return [...providerSet].map((name) => ({ value: name }));
}
