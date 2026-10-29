/**
 * 会话分组 IPC：只做边界适配（入参校验 / 日志），业务在 SessionGroupStore。
 *
 * 侧栏是只读消费方（v1），写入方是宿主插件页（sessionGroups.manage）；两条写路径
 * 都收口到同一个 store，store.onChanged 由装配层转成 session-groups:changed 广播。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SaveSessionGroupInput } from "../../shared/types";
import type { SessionGroupStore } from "../sessionGroups/sessionGroupStore";
import type { AppLogger } from "../logging/AppLogger";

export type SessionGroupsIpcDeps = {
	store: SessionGroupStore;
	appLogger: AppLogger;
};

/** 渲染层/插件提交的分组入参只做形状与上限校验；字段白名单收窄在 store.save。 */
function parseSaveInput(value: unknown): SaveSessionGroupInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid-session-group");
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 200) throw new Error("invalid-session-group");
	if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id.length > 200)) throw new Error("invalid-session-group");
	if (raw.sessionIds !== undefined && (!Array.isArray(raw.sessionIds) || raw.sessionIds.length > 30_000)) throw new Error("invalid-session-group");
	if (raw.dirs !== undefined && (!Array.isArray(raw.dirs) || raw.dirs.length > 1_000)) throw new Error("invalid-session-group");
	return raw as unknown as SaveSessionGroupInput;
}

function parseGroupId(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id || id.length > 200) throw new Error("invalid-session-group");
	return id;
}

/** 批量 id 入参（排序）：未知 id 交给 store 容错（调用方可能拿着旧快照）。 */
function parseGroupIdList(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 500) throw new Error("invalid-session-group");
	return value.map((id) => parseGroupId(id));
}

/** 注册会话分组 IPC；返回清理函数（卸载时摘掉全部 handler）。 */
export function registerSessionGroupsIpc(deps: SessionGroupsIpcDeps): () => void {
	const { store, appLogger } = deps;

	ipcMain.handle(ipcChannels.sessionGroupsList, async () => {
		return store.list();
	});

	ipcMain.handle(ipcChannels.sessionGroupsSave, async (_event, input: unknown): Promise<unknown> => {
		const parsed = parseSaveInput(input);
		const groups = await store.save(parsed);
		void appLogger.info("sessionGroups", "Saved session group", { groupId: parsed.id ?? "(new)", name: parsed.name });
		return groups;
	});

	ipcMain.handle(ipcChannels.sessionGroupsDelete, async (_event, groupId: unknown): Promise<boolean> => {
		const id = parseGroupId(groupId);
		const removed = await store.delete(id);
		void appLogger.info("sessionGroups", "Deleted session group", { groupId: id, removed });
		return removed;
	});

	ipcMain.handle(ipcChannels.sessionGroupsReorder, async (_event, groupIds: unknown): Promise<unknown> => {
		const ids = parseGroupIdList(groupIds);
		return store.reorder(ids);
	});

	return () => {
		ipcMain.removeHandler(ipcChannels.sessionGroupsList);
		ipcMain.removeHandler(ipcChannels.sessionGroupsSave);
		ipcMain.removeHandler(ipcChannels.sessionGroupsDelete);
		ipcMain.removeHandler(ipcChannels.sessionGroupsReorder);
	};
}
