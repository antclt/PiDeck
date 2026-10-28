/**
 * 收藏（回复 / 划选片段 / 会话）的共享契约。
 *
 * 收藏是 PiDeck 自己的本地数据（<userData>/favorites.json），**不写入会话文件、不改 pi 协议**：
 * 回复与片段存「收藏那一刻的正文快照」，会话删除或消息编辑后仍可读；
 * 会话收藏只存引用（sessionId/title/projectId），点击跳回原会话，不复制正文。
 * sessionId/messageId 只作为「来源」元信息，用于展示与后续跳转，不承担可读性。
 */

/** 单条收藏保存的正文上限：超出截断并标记 truncated（避免 favorites.json 无限膨胀）。 */
export const FAVORITE_TEXT_MAX_CHARS = 60_000;
/** IPC 入参的正文上限：只挡误传的超大载荷，真正的落盘上限由 FAVORITE_TEXT_MAX_CHARS 截断。 */
export const FAVORITE_TEXT_INPUT_MAX_CHARS = 400_000;
/** 收藏条数上限：超出时丢弃最旧的一条（按 createdAt 倒序保留）。 */
export const FAVORITE_ENTRY_LIMIT = 2_000;
/** id / 会话 id / 项目 id 等元信息的长度上限。 */
export const FAVORITE_META_MAX_CHARS = 200;
/** 会话标题长度上限。 */
export const FAVORITE_SESSION_TITLE_MAX_CHARS = 200;

/** 收藏来源：整条消息快照 / 划选片段 / 整个会话（引用，不复制正文）。 */
export type FavoriteKind = "message" | "selection" | "session";

/** 快照所属消息角色；划选片段可能跨块，未知时为 null。 */
export type FavoriteRole = "user" | "assistant" | "system";

export type FavoriteEntry = {
	id: string;
	/** 收藏时刻（epoch ms）：列表按此倒序，页面直接展示完整日期时间。 */
	createdAt: number;
	kind: FavoriteKind;
	/** 正文快照（消息为 Markdown 源码，片段为纯文本）；会话收藏为空字符串。 */
	text: string;
	role: FavoriteRole | null;
	sessionId: string | null;
	sessionTitle: string | null;
	projectId: string | null;
	/** 来源消息 id（仅元信息，目标失效不影响阅读）。 */
	messageId: string | null;
	/** 收藏时该回复使用的模型（provider/modelId），可空。 */
	model: string | null;
	/** 收藏时回复仍在生成：快照来自屏幕上的纯文本，可能不完整。 */
	partial: boolean;
	/** 正文超过 FAVORITE_TEXT_MAX_CHARS 被截断。 */
	truncated: boolean;
};

/** 渲染层提交的收藏入参（主进程按白名单收窄，多余字段丢弃）。 */
export type AddFavoriteInput = {
	kind: FavoriteKind;
	text: string;
	role?: FavoriteRole | null;
	sessionId?: string | null;
	sessionTitle?: string | null;
	projectId?: string | null;
	messageId?: string | null;
	model?: string | null;
	partial?: boolean;
};
