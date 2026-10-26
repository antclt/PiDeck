import type { DatabaseSync } from "node:sqlite";

// OpenCode 导入的共享解析模型。v1（session/message/part 三表）与 v2（session_v2/session_message
// 两表，2.x 起新会话只写后者，#410）读出后都归一到同一形态，convertToPiSession 不感知源代次。
export type OpenCodeMessage = {
	id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, any>;
	parts: OpenCodePart[];
};

export type OpenCodePart = {
	id: string;
	message_id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, any>;
};

export type ParsedOpenCodeSession = {
	meta: Record<string, any>;
	messages: OpenCodeMessage[];
	sourcePath: string;
	/** OpenCode 所有历史在同一个 DB 中，列表里展示单会话内容估算大小，而不是整个数据库大小。 */
	sourceSize: number;
	sourceMtime: number;
};

export function parseJson(value: unknown): Record<string, any> {
	if (typeof value !== "string") return value && typeof value === "object" ? (value as Record<string, any>) : {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function estimateSessionSize(meta: Record<string, any>, messages: OpenCodeMessage[]) {
	// 逐条累加而非整包 stringify：估算语义不变，瞬时峰值从「整会话字符串」降到「单条消息字符串」。
	// 口径与旧公式有常数级偏差，存量已导入会话会一次性显示 outdated（重新导入即刷新，无数据风险）
	let total = Buffer.byteLength(JSON.stringify(meta), "utf8");
	for (const message of messages) total += Buffer.byteLength(JSON.stringify(message), "utf8");
	return total;
}

/**
 * 读取 session_v2 / session_message（OpenCode 2.x 会话源）。
 * 表不存在时返回空列表（1.x 老库没有 v2 表）；tables 是调用方已取好的 sqlite_master 表名快照，
 * 避免每路来源各自查一次。
 */
export function readOpenCodeV2Sessions(input: { db: DatabaseSync; normalizedProject: string; dbPath: string; mtimeMs: number; tables: ReadonlySet<string> }): ParsedOpenCodeSession[] {
	if (!input.tables.has("session_v2") || !input.tables.has("session_message")) return [];
	const sessions = input.db
		.prepare(`
			select s.*, p.worktree
			from session_v2 s
			join project p on p.id = s.project_id
			where s.parent_id is null
			  and (lower(replace(p.worktree, '\\', '/')) = lower(?)
			   or lower(replace(s.directory, '\\', '/')) = lower(?)
			   or lower(replace(s.directory, '\\', '/')) like lower(? || '/%'))
			order by s.time_updated desc
		`)
		.all(input.normalizedProject, input.normalizedProject, input.normalizedProject) as Array<Record<string, any>>;

	return sessions.map((session) => {
		// 排序按 seq（事件序）而非 time_created：seq 是 v2 的权威重放顺序，时间戳同毫秒会并列
		const rows = input.db.prepare("select id, type, time_created, time_updated, data from session_message where session_id = ? order by seq asc").all(String(session.id)) as Array<Record<string, any>>;
		const messages = rows.map(parseV2MessageRow).filter((message): message is OpenCodeMessage => message !== null);
		return {
			meta: session,
			messages,
			sourcePath: `${input.dbPath}#${session.id}`,
			sourceSize: estimateSessionSize(session, messages),
			sourceMtime: input.mtimeMs,
		};
	});
}

/**
 * v2 消息按 type 列分派、正文存 data JSON（id/type 已拆到专列）。只保留 user / assistant 会话正文；
 * model-switched / synthetic / system / shell / compaction / idle 等过程标记与 v1 的
 * IMPORTED_SKIP_PART_TYPES 过程噪声同口径丢弃。
 */
function parseV2MessageRow(row: Record<string, any>): OpenCodeMessage | null {
	const type = String(row.type ?? "");
	if (type !== "user" && type !== "assistant") return null;
	const data = parseJson(row.data);
	const record = data && typeof data === "object" ? (data as Record<string, any>) : {};
	const time = record.time && typeof record.time === "object" ? (record.time as Record<string, any>) : {};
	const timeCreated = Number(row.time_created ?? time.created ?? 0);
	const timeUpdated = Number(row.time_updated ?? timeCreated);
	const id = String(row.id ?? "");
	if (type === "user") return v2UserMessage(id, timeCreated, timeUpdated, record);
	return v2AssistantMessage(id, timeCreated, timeUpdated, record);
}

function v2UserMessage(id: string, timeCreated: number, timeUpdated: number, data: Record<string, any>): OpenCodeMessage {
	const parts: OpenCodePart[] = [];
	const text = v2String(data.text);
	if (text) parts.push(v2Part("text", { text }, timeCreated));
	// FileAttachment 是 {data: base64, mime, source, name?}，对齐成 v1 file part 字段：
	// 图片由 tryImportedImageBlock 消费（读 data/mime），非图片占位读 filename。
	for (const file of v2Array(data.files)) {
		parts.push(v2Part("file", { filename: v2String(file.name) || "attachment", mime: v2String(file.mime), data: v2String(file.data) || undefined }, timeCreated));
	}
	return { id, time_created: timeCreated, time_updated: timeUpdated, data: { role: "user" }, parts };
}

function v2AssistantMessage(id: string, timeCreated: number, timeUpdated: number, data: Record<string, any>): OpenCodeMessage {
	const model = v2Record(data.model);
	const parts: OpenCodePart[] = [];
	for (const item of v2Array(data.content)) {
		const contentType = v2String(item.type);
		if ((contentType === "text" || contentType === "reasoning") && v2String(item.text)) {
			parts.push(v2Part(contentType, { text: item.text }, timeCreated));
		} else if (contentType === "tool") {
			const state = v2Record(item.state);
			parts.push(
				v2Part(
					"tool",
					{
						callID: v2String(item.id) || `${id}:${parts.length}`,
						tool: v2String(item.name) || "tool",
						state: {
							status: v2String(state.status),
							input: v2Record(state.input),
							output: v2ToolOutput(state),
							error: v2ErrorText(state.error),
						},
					},
					timeCreated,
				),
			);
		}
	}
	return {
		id,
		time_created: timeCreated,
		time_updated: timeUpdated,
		data: {
			role: "assistant",
			// model ref 是 {id, providerID}；缺失时留空让 convertToPiSession 落回会话级 model
			...(v2String(model.providerID) ? { providerID: v2String(model.providerID) } : {}),
			...(v2String(model.id) ? { modelID: v2String(model.id) } : {}),
			finish: data.finish,
			tokens: v2Tokens(data.tokens),
		},
		parts,
	};
}

function v2ToolOutput(state: Record<string, any>) {
	// v2 工具输出在 state.content（text/file 块数组）而不是 v1 的 state.output 字符串；
	// 拼成纯文本对齐旧口径，输出为空时留 undefined 让 extractToolOutput 落到 error 文本
	const text = v2Array(state.content)
		.map((block) => (v2String(block.type) === "text" ? v2String(block.text) : `[attachment: ${v2String(block.name) || v2String(block.uri) || "file"}]`))
		.filter(Boolean)
		.join("\n");
	return text || undefined;
}

function v2ErrorText(value: unknown) {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, any>;
	// SessionError 编码是 {type, message, ...}；message 缺失时退回整包 JSON，保证错误可见
	const message = v2String(record.message);
	return message || JSON.stringify(record);
}

function v2Tokens(value: unknown) {
	const record = v2Record(value);
	if (!record || (record.input === undefined && record.output === undefined)) return undefined;
	// v2 无 total 字段；output 口径通常已含 reasoning，不重复累加
	return { ...record, total: Number(record.input ?? 0) + Number(record.output ?? 0) };
}

function v2Part(type: string, fields: Record<string, any>, timestamp: number): OpenCodePart {
	return { id: "", message_id: "", time_created: timestamp, time_updated: timestamp, data: { type, ...fields } };
}

function v2Record(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function v2Array(value: unknown): Record<string, any>[] {
	return Array.isArray(value) ? value.filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object") : [];
}

function v2String(value: unknown): string {
	return typeof value === "string" ? value : "";
}
