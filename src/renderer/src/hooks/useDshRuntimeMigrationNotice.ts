/**
 * 存量 DSH 用户的 runtime 迁移提示（AgentRuntimeProvider 阶段 2）。
 *
 * 背景：runtime 外置后，升级上来的用户可能带着 dsh 会话/配置，但本地没有 runtime
 * （要么是新装、要么 runtime 被回收）。此时 DSH 相关 UI 处于门控态，用户会看到
 * 「会话打不开 / 设置页变成安装引导」而不知道发生了什么。
 *
 * 因此：确认存在 dsh 痕迹（session catalog 里有 dsh 会话）且 runtime 未安装时，
 * 主动提示一次并给出直达入口。只提示一次——反复弹等于把提示变成骚扰。
 */
import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { dshRuntimeStatusAtom } from "../atoms/dsh-atoms";
import { sessionRecordsAtom } from "../atoms/session-atoms";
import { openSettingsAtom } from "../atoms/app-ui-atoms";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/** 打开「配置管理」页并落在 DSH 后端分页（runtime 未装时概览页即安装引导）。 */
function useOpenConfigPane() {
	const openSettings = useSetAtom(openSettingsAtom);
	return () => openSettings({ tab: "common", pane: "config", backendPane: "dsh" });
}

export function useDshRuntimeMigrationNotice(): void {
	const status = useAtomValue(dshRuntimeStatusAtom);
	const store = useStore();
	const openConfigPane = useOpenConfigPane();
	const promptedRef = useRef(false);

	useEffect(() => {
		// checking 期间不判断：状态未定，避免拿中间态误报。
		if (status.state === "checking" || status.state === "installed") return;
		if (promptedRef.current) return;
		const records = store.get(sessionRecordsAtom);
		const hasDshSessions = Object.values(records).some((record) => record.backend === "dsh");
		if (!hasDshSessions) return;
		promptedRef.current = true;
		showNotice(t("dsh.runtime.migrationNotice"), 8000, "info", undefined, {
			action: { label: t("dsh.runtime.migrationAction"), onClick: openConfigPane },
		});
	}, [status.state, store, openConfigPane]);
}
