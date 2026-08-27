import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
	getFilePathVerdict,
	requestFilePathVerdicts,
	subscribeFilePathVerdicts,
} from "../../utils/filePathVerdictStore";
import { resolveFileLinkPath } from "../../utils/filePathLinks";

/**
 * 文件路径链接的「解析基准目录」上下文。
 *
 * remarkLinkifyPaths 渲染出的链接是回复原文里的路径字符串（相对/绝对皆有），
 * 校验与点击打开都必须相对同一基准目录解析——App 层用与 handleOpenLinkedFile
 * 完全相同的口径（activeAgent?.cwd ?? activeProject?.path）提供，保证
 * 「校验存在的路径」=「点击能打开的路径」。未挂载 Provider 的场景
 * （独立静态渲染等）值为 undefined：绝对路径仍可校验，相对路径保持链接现状。
 */
const FileLinkBaseContext = createContext<string | undefined>(undefined);

export function FileLinkBaseProvider(props: {
	baseDir: string | undefined;
	children: ReactNode;
}) {
	return (
		<FileLinkBaseContext.Provider value={props.baseDir}>
			{props.children}
		</FileLinkBaseContext.Provider>
	);
}

export function useFileLinkBaseDir(): string | undefined {
	return useContext(FileLinkBaseContext);
}

/**
 * 单个路径的存在性判定订阅：首次遇到未校验路径时登记批量请求（store 内部
 * 去抖合并 IPC），结果经缓存广播回来；undefined 表示未知/校验中。
 * 每个文件锚点独立订阅自己的键，避免一条长回复整体重渲染。
 */
export function useFilePathExists(rawPath: string | undefined): boolean | undefined {
	const baseDir = useFileLinkBaseDir();
	// resolveFileLinkPath 返回 null = 无法解析（空路径/无基准目录的相对路径）：
	// 与 undefined 同义处理——不发校验、不判不存在，避免拿主进程 cwd 乱猜误判。
	const absPath = rawPath === undefined ? undefined : resolveFileLinkPath(rawPath, baseDir);
	const resolvable = typeof absPath === "string";
	useEffect(() => {
		if (!rawPath || !resolvable || absPath === undefined) return;
		requestFilePathVerdicts([absPath]);
	}, [absPath, rawPath, resolvable]);
	return useSyncExternalStore(
		subscribeFilePathVerdicts,
		() => (resolvable ? getFilePathVerdict(absPath) : undefined),
	);
}
