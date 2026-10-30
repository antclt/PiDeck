import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import type { AcpSessionConfigOption } from "../../../shared/types/acp";

/**
 * IPC 失败文案去掉传输前缀：Electron 会把主进程的 throw 包成
 * "Error invoking remote method 'acp:session-config-set': Error: …"，只留原因部分给用户看。
 */
function errorText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

/**
 * ACP 会话级配置(configOptions 规范路径)的渲染层状态:
 * 挂载/agentId 变化时拉一次枚举,订阅 acp:session-config-changed 增量更新
 * (set 响应与 config_option_update 通知共用同一事件)。
 *
 * agentId 按 runtime 隔离:事件带 agentId,旧 agent 的迟到事件被过滤;
 * agent 未提供 configOptions 时 options 为 undefined(调用方隐藏选择器)。
 * 读取失败静默为 undefined(切换/关闭瞬间的 IPC 失败不值得打扰用户);
 * 下发失败则要提示:agent 明确拒绝时必须让用户知道为什么没生效(见 setOption 的 catch)。
 */
export function useAcpSessionConfig(agentId: string | undefined, backend: string | undefined) {
	type Scope = { agentId: string; revision: number };
	const scopeRef = useRef<Scope | undefined>(undefined);
	const [snapshot, setSnapshot] = useState<{ scope: Scope; options?: AcpSessionConfigOption[] } | undefined>(undefined);
	const enabled = backend === "acp" && typeof agentId === "string" && agentId.length > 0;

	useEffect(() => {
		setSnapshot(undefined);
		if (!enabled || !agentId) return;
		const scope: Scope = { agentId, revision: 0 };
		scopeRef.current = scope;
		// 先订阅再读取；读取中的更新具有更高 revision，旧枚举不能覆盖新通知。
		const unsubscribe = desktopApi.acp.onSessionConfigChanged((event) => {
			if (scopeRef.current !== scope || event.agentId !== agentId) return;
			scope.revision += 1;
			setSnapshot({ scope, options: event.options });
		});
		const revision = scope.revision;
		void desktopApi.acp
			.getSessionConfig(agentId)
			.then((result) => {
				if (scopeRef.current === scope && scope.revision === revision) setSnapshot({ scope, options: result ?? undefined });
			})
			.catch(() => undefined);
		return () => {
			if (scopeRef.current === scope) scopeRef.current = undefined;
			unsubscribe();
		};
	}, [enabled, agentId]);

	const setOption = useCallback(
		async (optionId: string, value: string | boolean) => {
			const scope = scopeRef.current;
			if (!enabled || !agentId || scope?.agentId !== agentId) return;
			const revision = ++scope.revision;
			try {
				const options = await desktopApi.acp.setSessionConfig(agentId, optionId, value);
				// 复用的 Composer、runtime 重启、连续选择都可能让应答迟到。
				if (scopeRef.current === scope && scope.revision === revision) setSnapshot({ scope, options });
			} catch (error) {
				// 只对「agent 明确拒绝」出声：切换/关闭瞬间的 IPC 失败属于竞态噪声（scope 已换），
				// 静默保留旧值即可。拒绝必须提示——否则 chip 原地弹回旧值，用户只会以为点了没反应
				// （Qoder CLI 把 Bypass Permissions 列为可选值却回 unknown permission_mode）。
				if (scopeRef.current !== scope || scope.agentId !== agentId) return;
				showNotice(t("acp.configOptionRejected", { option: optionId, value: String(value), reason: errorText(error) }), undefined, "warning");
				// 被拒时本地没有权威值可回滚（事件只在写入成功时整表回推），chip 会一直显示
				// 「已切换」而 agent 侧没变（toolMode 首次代理回复后锁定就是这种）。重拉一次
				// 服务端真相覆盖 snapshot；带 scope + revision 校验，迟到的旧枚举不能盖掉更新的状态。
				void desktopApi.acp
					.getSessionConfig(agentId)
					.then((next) => {
						if (scopeRef.current === scope && scope.revision === revision) setSnapshot({ scope, options: next ?? undefined });
					})
					.catch(() => undefined);
			}
		},
		[enabled, agentId],
	);

	// effect 清理在 paint 后执行；首帧也必须屏蔽旧 scope，不能露出 A 枚举 + B setter。
	const options = enabled && snapshot?.scope === scopeRef.current && snapshot?.scope.agentId === agentId ? snapshot.options : undefined;
	return { options, setOption };
}
