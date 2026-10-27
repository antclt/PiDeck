/**
 * catalog 变更广播：把「哪些项目需要重拉会话列表」推给渲染层（sessions:catalog-refreshed）。
 *
 * 抽成独立模块的理由：`mainWindow` 是 index.ts 的模块级变量，真正值得单测的只有两条守卫——
 * 窗口已销毁就不发、同一项目只发一次（渲染层按项目静默重拉，重复事件等于白跑两遍扫描）。
 * 调用点的缺漏（issue #436：Web API 删会话没广播）仍靠 index.ts 的接线断言兜。
 */
export type CatalogRefreshWindow = {
	isDestroyed(): boolean;
	webContents: { send(channel: string, payload: { projectId: string }): void };
};

export function broadcastCatalogRefreshed(projectIds: Iterable<string>, deps: { channel: string; getWindow: () => CatalogRefreshWindow | null | undefined }): void {
	const window = deps.getWindow();
	if (!window || window.isDestroyed()) return;
	for (const projectId of new Set(projectIds)) {
		// 空 projectId 会让渲染层按「未知项目」重拉整张表；宁可少发一次，也不发脏数据。
		if (!projectId) continue;
		window.webContents.send(deps.channel, { projectId });
	}
}
