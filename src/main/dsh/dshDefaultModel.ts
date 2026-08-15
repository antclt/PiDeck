/**
 * DSH 部署默认模型选择解析（settings.yaml 的 agent-default-model 段，纯函数可单测）。
 *
 * 动机：草稿/未启动的 DSH 会话在 host 里还没有会话，wire 上没有「当前部署默认模型」
 * 的 RPC（llm.models 只给目录、session.models 需要会话）。底栏/选择器要展示
 * 默认模型与思考档位，只能从 DSH_HOME/settings.yaml 读取（host 写出的简单 YAML）。
 *
 * 只解析本段：`agent-default-model:` 下的 provider / model / reasoningEffort 三个
 * 缩进键；其余内容忽略。解析失败返回 undefined（调用方回退为不展示默认值）。
 */
export type DshDefaultModel = {
	provider: string;
	model: string;
	reasoningEffort?: string;
};

/** 行级解析 settings.yaml 的 agent-default-model 段。 */
export function parseAgentDefaultModel(yaml: string): DshDefaultModel | undefined {
	let inSection = false;
	let result: Partial<DshDefaultModel> | undefined;
	for (const raw of yaml.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		if (!inSection) {
			// 顶格 key：命中 agent-default-model 进入该段，其他顶格 key 继续找
			if (/^agent-default-model\s*:/.test(line)) {
				inSection = true;
			}
			continue;
		}
		// 段内：顶格非空行 = 段结束
		if (!/^[ \t]/.test(line)) break;
		const match = /^[ \t]+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1];
		let value = match[2].trim();
		if (value === "" || value.startsWith("#")) continue;
		// 去行尾注释（引用值不拆：URL/含 # 的值保留）
		if (!/^['"]/.test(value)) {
			const comment = value.indexOf(" #");
			if (comment >= 0) value = value.slice(0, comment).trim();
		}
		// 去引号
		if (value.length >= 2 && (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)) {
			value = value.slice(1, -1);
		}
		if (key === "provider") (result ??= {}).provider = value;
		else if (key === "model") (result ??= {}).model = value;
		else if (key === "reasoningEffort") (result ??= {}).reasoningEffort = value;
	}
	return result && result.provider && result.model
		? {
				provider: result.provider,
				model: result.model,
				reasoningEffort: result.reasoningEffort,
			}
		: undefined;
}
