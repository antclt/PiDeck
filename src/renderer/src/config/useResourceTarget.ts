import { useCallback, useMemo, useState } from "react";
import type { PiResourceOptions, PiResourceTarget } from "../../../shared/piConfig";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import type { PiConfigTargetHost } from "./piConfigTargetModel";
import { resourceMutationAllowed, resourceTargetOptions, toResourceTargetHosts } from "./piResourceTargetModel";
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
	const readOnly = global && !resourceMutationAllowed(resourceTarget);
	/** true = 已拦下并提示（调用方直接 return）；false = 放行。 */
	const blockMutation = useCallback(() => {
		if (!readOnly) return false;
		showNotice(t("config.resourceTarget.readOnly"), 5000, "warning");
		return true;
	}, [readOnly]);
	return { resourceTarget, setResourceTarget, targetHosts, options, readOnly, blockMutation };
}

export type ResourceTargetView = ReturnType<typeof useResourceTarget>;
