/**
 * 远端会话的模型目录决策（纯策略，依赖全部注入 ⇒ 可单测）。
 *
 * 顺序是刻意的：
 * 1. **远端主机上的 `pi --list-models`**：与 runtime 解耦（草稿期也能给目录、进程回收后不会突然
 *    变空），结果按主机缓存，与本机同一个解析函数。
 * 2. 活着的远端 pi 进程（`get_available_models`）：只在 CLI 根本拿不到时补位——它可能带上扩展
 *    贡献的模型，但要挂在会话生命周期上，不能当主来源。
 * 3. 都不行：如实返回 CLI 的失败报告。
 *
 * **任何分支都不返回本机目录**：远端会话展示本机模型，用户选中后 `set_model` 会在远端被拒，
 * 然后被偏好降级链路静默改回远端默认模型，而界面仍显示本机模型名——正是「远端能聊但选不了
 * 我那边的模型」这个 bug 的形态。
 */
import type { ModelListReport } from "../../shared/types";

export type RemoteModelReportRoutingDeps = {
	/** 远端项目目录（`pi --list-models`，按主机缓存）；非远端项目返回 null。 */
	loadCatalog: (projectId: string) => Promise<ModelListReport | null>;
	/** 问一台活着的远端 pi 进程；失败返回 null。 */
	askRuntime: (agentId: string) => Promise<ModelListReport | null>;
};

/** 「所有来源都失败」时的报告：不是错误码，而是可操作提示（远端会话没有可用目录来源）。 */
export function remoteModelCatalogUnavailable(): ModelListReport {
	return { models: [], ok: false, reason: "remote-inactive", version: null, detail: "", source: "none", at: Date.now() };
}

export async function resolveRemoteModelReport(input: { projectId: string; liveAgentId?: string }, deps: RemoteModelReportRoutingDeps): Promise<ModelListReport> {
	// 不按 projectId 是否为空设门：位置真相在会话 locator 上（host rebind 会改写它），
	// 「没有 projectId 但会话在远端」也必须查目录。非远端项目由 loadCatalog 返回 null 表示。
	const cliReport = await deps.loadCatalog(input.projectId);
	// CLI 成功就直接用：它比 runtime 更"有空"，而且已经进缓存了。
	if (cliReport?.ok === true) return cliReport;
	if (input.liveAgentId !== undefined) {
		const runtimeReport = await deps.askRuntime(input.liveAgentId);
		if (runtimeReport !== null) return runtimeReport;
	}
	// CLI 尝试过但失败：把它的失败原因交给调用方展示（比 remote-inactive 更有信息量）。
	if (cliReport !== null) return cliReport;
	return remoteModelCatalogUnavailable();
}
