import type { RuntimePromptTemplate } from "../../../shared/types/prompts";
import { parseArgumentHint, type PromptTemplateInfo } from "../composerBehavior";

/**
 * 输入框模板表的来源合并（用户目录/项目目录 ∪ pi 运行时模板）。
 *
 * 为什么需要两份来源：
 * - 来源 A（`prompts:list` / `listByProject`）覆盖 `~/.pi/agent/prompts` 与 `<项目>/.pi/prompts`，
 *   带 description / path / enabled 等编辑元数据，离线可用。
 * - 来源 B（pi `get_commands` 的 `source: "prompt"` 条目 + 按路径读回的正文）覆盖 **pi 实际
 *   加载的全部模板**，包括已安装 npm 包声明的 `pi.prompts`（如 pi-subagents 的
 *   `parallel-review`），这部分 A 看不到。
 *
 * 合并规则：
 * 1. 同名时**正文取 B**——B 是 pi 去重后的最终视图，用它展开才与 pi 的行为一致；
 *    A 的展示元数据（description/path/enabled）继续沿用，避免菜单里丢描述。
 * 2. B 独有条目追加在后，description 用 pi 给的命令描述，`path` 留空（不可编辑）。
 * 3. 顺序：A 原有顺序不变，B 新增项按 pi 的命令表顺序追加。
 */
export function mergeRuntimeTemplates(base: PromptTemplateInfo[], runtime: readonly RuntimePromptTemplate[]): PromptTemplateInfo[] {
	if (runtime.length === 0) return base;
	const runtimeByName = new Map(runtime.map((template) => [template.name, template]));
	const merged = base.map((template) => {
		const override = runtimeByName.get(template.name);
		if (!override) return template;
		runtimeByName.delete(template.name);
		// 正文以 pi 的为准；描述缺失时保留 A 的，避免已配置的说明被空串覆盖
		return {
			...template,
			content: override.content,
			description: template.description || override.description || "",
		};
	});
	for (const template of runtimeByName.values()) {
		merged.push({
			name: template.name,
			// 包带模板不在 PiDeck 的可编辑目录里，path 留空表示「不可编辑」
			path: "",
			description: template.description ?? "",
			content: template.content,
			argumentHint: parseArgumentHint(template.content),
		});
	}
	return merged;
}
