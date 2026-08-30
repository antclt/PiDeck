/**
 * 后端无关的待办数据契约（DSH 官方 `todos` projection / `todo/write` 快照归一化）。
 *
 * DSH 的最小模型（content + 三态 status）与 Pi 扩展 widget 行是两套输入形态：
 * 主进程统一归一化成本类型，渲染层再把它适配到统一会话组件卡的展示模型。
 * 这里只定义纯数据，不携带任何 UI/扩展私有字段（id、branch、dismiss 等均不进共享契约）。
 */

/** 生命周期状态：pending（未开始）/ in_progress（正在推进）/ completed（已完成）。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 一条待办：短命令式的正文 + 三态状态（与 DSH TodoItem 同构）。 */
export type TodoItem = {
	content: string;
	status: TodoStatus;
};
