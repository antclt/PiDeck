import { useCallback, useMemo, useState } from "react";
import type { PiResourceOptions, PiResourceTarget } from "../../../shared/piConfig";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import type { PiConfigTargetHost } from "./piConfigTargetModel";
import { resourceTargetOptions, resourceWriteAllowed, toResourceTargetHosts, type PiResourceWriteAction } from "./piResourceTargetModel";
import type { ResourceScope } from "./resourceScopeModel";

/**
 * 资源三页（技能/提示词/扩展）的目标状态与门禁。
 *
 * 放 hook 而不是 ConfigModal 内联：选择器只在全局作用域出现（项目作用域是项目目录，与档案无关）；
 * IPC options 只在 wsl 目标带上；本轮未路由的写操作统一在这里拦住，避免三页各写一套判断。
 */
export function useResourceTarget(hosts: readonly PiConfigTargetHost[], resourceScope: ResourceScope) {
	const [resourceTarget, setResourceTarget] = useState<PiResourceTarget>({ kind: "local" });
	const targetHosts = useMemo(() => toResourceTargetHosts(hosts), [hosts]);
	const global = resourceScope === "global";
	const options = useMemo<PiResourceOptions | undefined>(() => (global ? resourceTargetOptions(resourceTarget) : undefined), [global, resourceTarget]);
	/** 非本机目标：提示条显示「部分动作只支持本机」，真正拦不拦由 blockMutation(action) 判定。 */
	const readOnly = global && resourceTarget.kind !== "local";
	/** true = 该动作在当前目标下已拦下并提示（调用方直接 return）；false = 放行。 */
	const blockMutation = useCallback(
		(action: PiResourceWriteAction) => {
			if (!global) return false;
			if (resourceWriteAllowed(action, resourceTarget)) return false;
			showNotice(t("config.resourceTarget.writeUnsupported"), 5000, "warning");
			return true;
		},
		[global, resourceTarget],
	);
	return { resourceTarget, setResourceTarget, targetHosts, options, readOnly, blockMutation };
}

export type ResourceTargetView = ReturnType<typeof useResourceTarget>;
