import { createTextTransformCache } from "../../../../../shared/fileChanges.ts";

/**
 * 助手正文的展示文本：去掉终端控制码和内嵌思考，保留现有正文清理语义。
 * 渲染、过程计数和分组必须共用此结果，避免原文非空但页面没有正文时仍计入中间回复。
 * 只返回展示副本，不改写历史消息，也不移除 live 正文需要的骨架挂载点。
 *
 * 按输入字符串缓存（见 shared/fileChanges 的 createTextTransformCache）：同一条消息的正文在
 * 一次渲染里会被 5 处各清理一遍 —— buildTurnDisplay 判定正文与 hasFoldableContent、
 * groupTurnProcess 分组、buildProcessSummary 计数、TurnRow 拼复制正文。流式期间窗口段
 * 每 50ms 整段重分组，5 × 20/s 的全文正则扫描是「虚拟化后思维链区域仍卡顿」的直接来源：
 * 虚拟化裁掉的是 DOM，裁不掉这条字符串流水线。
 */
export const cleanAnswerText = createTextTransformCache((text: string) => {
	return text
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.trim();
});
