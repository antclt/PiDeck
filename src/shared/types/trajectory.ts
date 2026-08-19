/**
 * 会话 JSONL 里的非对话过程事件。
 * 时间线只投影 user/assistant/tool；轨迹复盘单独读这些条目，不改聊天渲染。
 */
export type SessionProcessEventKind =
	| "session"
	| "sessionInfo"
	| "modelChange"
	| "thinkingChange"
	| "compaction"
	| "custom"
	| "import"
	| "retry";

export type SessionProcessEvent = {
	id: string;
	kind: SessionProcessEventKind;
	timestamp: number;
	summary: string;
	detail?: string;
	cwd?: string;
	parentSession?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
	tokensBefore?: number;
	/** 事件序号（DSH SessionEvent.seq）；账本按 seq 而不是墙钟排，对齐 dsh-web layout.ts。 */
	seq?: number;
	/** llm/retry：第几次重试（1-based）。 */
	retry?: number;
	maxRetries?: number;
	retryDelayMs?: number;
};
