/**
 * rewind 能力共享契约（P1：checkpoint 文件快照）。
 *
 * 设计决策：参考 pi-rewind 扩展（MIT）的 checkpoint 模型，但把「文件回退」做成
 * 主进程 GitService 域的纯 git 能力（不依赖 pi 进程），从而天然跨后端——
 * dsh 会话跑在同一个仓库里，checkpoint 照常可用；也避免 PiDeck 无法程序化
 * 驱动 pi 扩展命令的通道缺失问题（RPC 类型表里没有「执行扩展命令」）。
 *
 * 本文件只放跨进程契约类型 + 边界校验纯函数，禁止引入运行时依赖。
 * 完整元数据（含 git 树 SHA）保留在 src/main/rewind/checkpointCore.ts 内部，
 * 只有面向 IPC/UI 的摘要形态下沉到这里。
 */

/** checkpoint 触发来源（与 pi-rewind 对齐，保证两端创建的 ref 互相可读）。 */
export type RewindCheckpointTrigger = "turn" | "tool" | "resume" | "before-restore";

/** 回退范围：仅文件 / 仅会话 / 两者。会话回退走后端 fork（pi fork RPC），本类型先定契约。 */
export type RewindRestoreScope = "files" | "conversation" | "all";

/**
 * 回退执行结果：filesRestored 表示是否做了文件回退；
 * conversation/all 回退会 fork 出新会话，forkedSessionId 指向新会话 id（原会话保留）。
 */
export type RewindRestoreResult = {
	/** scope 含 "files"/"all" 时 true */
	filesRestored: boolean;
	/** conversation/all 时 fork 出的新会话 id；仅文件回退时为 undefined */
	forkedSessionId?: string;
};

/**
 * 面向 IPC/UI 的 checkpoint 摘要（不含 git 内部 SHA，避免把实现细节泄露给渲染层）。
 * 由 main/rewind 的 toCheckpointSummary 从完整元数据投影而来。
 */
export type RewindCheckpointSummary = {
	/** checkpoint id（= git ref 名最后一段，如 turn-<sessionUuid>-<turn>-<ts>） */
	id: string;
	/** 所属会话 id（PiDeck SessionRecord.id / pi sessionId） */
	sessionId: string;
	trigger: RewindCheckpointTrigger;
	turnIndex: number;
	/** trigger === "tool" 时的工具名（write/edit/bash） */
	toolName?: string;
	/** 人类可读描述（用户 prompt 摘要 / 工具参数摘要） */
	description?: string;
	/** 快照时刻所在 git 分支（恢复时的分支守卫用） */
	branch: string;
	/** 创建时刻（epoch ms） */
	timestamp: number;
	/** 因 >10MiB 跳过快照的文件；恢复时受保护不被误删 */
	skippedLargeFiles?: string[];
	/** 因 >=200 个文件跳过快照的目录；恢复时受保护不被误删 */
	skippedLargeDirs?: string[];
};

/** IPC 边界校验：回退范围枚举（渲染层入参一律不可信）。 */
export function isRewindRestoreScope(value: unknown): value is RewindRestoreScope {
	return value === "files" || value === "conversation" || value === "all";
}

/**
 * 检查点列表分页参数（时间倒序翻页，新的在前）。
 *
 * limit 默认 10、上限 100；beforeTimestamp 为游标：只返回 timestamp 严格早于
 * 该值的检查点（用上一页最后一条的 timestamp 翻页），避免 offset 分页在
 * 列表被新 checkpoint 插入时错位。
 */
export type RewindCheckpointPageParams = {
	/** 每页条数（默认 10，上限 100） */
	limit?: number;
	/** 游标：只返回 timestamp 早于该值的检查点 */
	beforeTimestamp?: number;
};

/** 检查点列表分页结果。 */
export type RewindCheckpointPage = {
	items: RewindCheckpointSummary[];
	/** 是否还有更早的检查点（决定「加载更多」按钮是否展示） */
	hasMore: boolean;
};

/**
 * IPC 边界校验：checkpoint id 必须是指向 ref 名的安全字符。
 * 该值会拼进 `update-ref refs/pi-checkpoints/<id>` 与 rev-parse，必须拒绝
 * 空格/路径分隔符/控制字符，防注入与越界访问其他 ref 命名空间。
 */
export function isRewindCheckpointId(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]+$/.test(value);
}
