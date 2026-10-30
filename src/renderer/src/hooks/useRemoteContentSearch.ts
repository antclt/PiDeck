import { useCallback, useEffect, useRef, useState } from "react";
import type { FileContentSearchResult } from "../../../shared/types";
import { readRootStatusResponse } from "../components/sidebar/remoteProjectStatusState";
import { desktopApi } from "../desktopApi";
import { remoteCapabilitiesAllowContentSearch, shouldRunRemoteContentSearch } from "../utils/fileSearchCapability";

/**
 * 远端内容搜索的渲染层两件套（W2）：
 *
 * 1. `useRemoteProjectContentSearchCapability`：能力只来自连接 hello —— rootStatus 的
 *    `helperCapabilities`。树根读完（session 已建立）后再问一次，旧 helper 的清单里没有
 *    `fs.searchContent`，面板据此继续只做文件名搜索；查询本身不建立会话。
 * 2. `useRemoteContentSearch`：提交式内容搜索（与文件名搜索同一个提交动作），代次作废迟到结果；
 *    只有 supported 时才发 IPC，失败/不可用一律回退 null（只显示文件名结果），不把能力边界伪装成错误。
 *
 * 与 `useFileSearch` 分开是有意的：那条 hook 绑定本机 file-index 的 `files.search`，远端名字搜索走
 * `remoteHosts.searchProject`，两个来源与能力判定都不同，合并会把两套语义焊死在一起。
 */

export function useRemoteProjectContentSearchCapability(projectId: string, ready: boolean): boolean {
	const [supported, setSupported] = useState(false);

	// 切项目立即回到"未知=不支持"：上一个项目的能力不能带进新项目。
	useEffect(() => {
		setSupported(false);
	}, [projectId]);

	useEffect(() => {
		if (!ready) return;
		let current = true;
		void (async () => {
			try {
				const view = readRootStatusResponse(await desktopApi.remoteHosts.rootStatus(projectId));
				if (!current) return;
				setSupported(view.status !== "unavailable" && remoteCapabilitiesAllowContentSearch(view.helperCapabilities));
			} catch {
				// A broken query is "unknown", and unknown is unsupported: never promise content hits we cannot serve.
				if (current) setSupported(false);
			}
		})();
		return () => {
			current = false;
		};
	}, [projectId, ready]);

	return supported;
}

export type RemoteContentSearchHandle = {
	results: FileContentSearchResult | null;
	isSearching: boolean;
	/** 发起一次内容搜索；不支持/词太短时只清态，不发 IPC。 */
	run: (query: string) => Promise<void>;
	reset: () => void;
};

export function useRemoteContentSearch(options: { projectId: string; supported: boolean }): RemoteContentSearchHandle {
	const [results, setResults] = useState<FileContentSearchResult | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const sequence = useRef(0);
	const { projectId, supported } = options;

	const reset = useCallback(() => {
		sequence.current += 1;
		setResults(null);
		setIsSearching(false);
	}, []);

	// 能力关闭或切项目：立刻丢掉上一位置的内容态，并作废在途请求。
	useEffect(() => {
		reset();
	}, [projectId, supported, reset]);

	useEffect(
		() => () => {
			sequence.current += 1;
		},
		[],
	);

	const run = useCallback(
		async (query: string) => {
			const trimmed = query.trim();
			if (!shouldRunRemoteContentSearch(supported, query)) {
				reset();
				return;
			}
			const generation = ++sequence.current;
			setIsSearching(true);
			try {
				const value = await desktopApi.files.searchContent(projectId, trimmed);
				if (generation === sequence.current) setResults(value);
			} catch {
				// 主进程把"旧 helper / 不可用"折叠成 null；这里只兜 IPC 失败，任何失败都不显示内容分区。
				if (generation === sequence.current) setResults(null);
			} finally {
				if (generation === sequence.current) setIsSearching(false);
			}
		},
		[projectId, supported, reset],
	);

	return { results, isSearching, run, reset };
}
