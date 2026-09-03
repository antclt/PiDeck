import { t } from "../i18n";

/**
 * 会话展示名：fork 会话把 (fork) 后缀直接拼进会话名本身（原标题右侧），
 * 使侧栏、Tab 栏、搜索、分支栏等所有展示点一致，而不是在某个组件上单独渲染后缀。
 * 数据层 title 保持原标题不变（重命名/扫描回填不冲突），仅展示时拼装。
 * 已带后缀（外部改名/重复调用）时不再追加，避免 "xxx (fork) (fork)"。
 */
export function sessionDisplayName(
	title: string | undefined,
	forked?: boolean,
): string | undefined {
	if (!title || !forked) return title;
	const suffix = t("session.forkedSuffix");
	if (!suffix) return title;
	return title.endsWith(suffix) ? title : `${title} ${suffix}`;
}
