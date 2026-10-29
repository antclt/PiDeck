/**
 * 文件域的公共读取形状（v5 T6）：本地与 SSH 都返回同一份形状，调用方不需要知道位置。
 *
 * 三条约束写在这里，避免后续为了“对齐”而漂移：
 * - `revision`/`generation` 只描述**这份事实的新鲜度**，不是写入授权收据（文本编辑的 `version` 另算）；
 * - `hasChildren` 本机是 exact（`true|false`），远端只能是 `"unknown"`——不能把“没查过”伪装成“没有子项”；
 * - `ignored` 只是 Git 判定的修饰，不是过滤条件；保护性隐藏规则（系统目录/回收站）仍由 backend 过滤。
 */
import type { Op } from "../op";
import type { ProjectFileTarget } from "./project";

export type ProjectDirectoryEntry = {
	target: ProjectFileTarget;
	relativePath: string;
	type: "file" | "directory";
	hasChildren: boolean | "unknown";
	/** Git ignore 修饰（仅当 backend 有 Git 判定时出现）；不是“隐藏”。 */
	ignored?: boolean;
};

export type ProjectDirectoryPage = {
	entries: ProjectDirectoryEntry[];
	truncated: boolean;
	/** 同一 generation 内的事实版本；不相等即表示内容被替换或标脏过。 */
	revision: number;
	/** 连接代（本机为稳定常量）；跨代一律丢弃缓存。 */
	generation: string;
};

export type ProjectDirectoryPageResult = Op<ProjectDirectoryPage>;

/** 批量存在性/类型（只读 fs 面；不签发任何 entry/文本授权）。 */
export type ProjectPathState = { target: ProjectFileTarget; exists: boolean; isDirectory: boolean };

export type ProjectPathsExistResult = Op<ProjectPathState[]>;
