import type { SessionRecord } from "../../../shared/types";

/**
 * 会话内查找（Ctrl/Cmd+Shift+F）可用的唯一判据：入口按钮（SessionHeader）与浮层
 * （ChatSessionPane）必须共用它，否则会出现「点了按钮没反应」或「浮层挂在 DSH 会话上
 * 永远没有匹配」。
 *
 * - 只扫 pi 会话 JSONL：DSH/ACP 没有该文件，走 sidecar 必然空结果（不挂入口）；
 * - 草稿会话尚未落盘（filePath 缺省）也不挂入口（否则放大镜悬在欢迎页上）。
 */
export function supportsSessionFind(record: Pick<SessionRecord, "backend" | "filePath"> | undefined): boolean {
	if (!record) return false;
	return (!record.backend || record.backend === "pi") && Boolean(record.filePath);
}
