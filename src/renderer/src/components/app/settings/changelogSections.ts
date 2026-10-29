/**
 * CHANGELOG 按版本段切分（纯函数，无 React 依赖，可单测）。
 *
 * 背景（2026-10-27 更新日志卡顿）：更新日志弹窗把主进程拉回的整本 CHANGELOG
 * （实测 400KB，数十个版本）一次性交给 MarkdownStream。即便走 light（关掉
 * 代码高亮/mermaid/数学等重插件），marked 解析 + sanitize + 一次 commit 出
 * 数万节点的成本仍与文本长度线性相关 —— 打开弹窗那一下明显卡顿。
 *
 * 用户绝大多数时候只关心刚发布的那个版本，因此默认只渲染首个版本段，
 * 「查看全部版本」展开才付全量成本（展开后由 MarkdownStream 的 settled
 * 渐进分块兜底，不会一次 commit 冻结）。
 *
 * 切分只读原文、不改写内容：`sections.join("\n")` 与原文「从首个版本标题起」的
 * 切片逐字节相同（每个版本段内部一字不改，见 tests/changelogSections.test.mjs）；
 * intro 是展示用的副本并做了 trim，所以它**不是**可直接拼回原文的切片——
 * 「查看全部版本」渲染的始终是原始 markdown 全文，不经过这里拼回。
 */

/** 版本段标题形如 `## v0.9.7 (2026-10-26)` / `## v0.7.8 - 2026-10-03`。 */
export function splitChangelogVersions(markdown: string): {
	/** 首个版本标题之前的导语（多数 CHANGELOG 为空串）。 */
	intro: string;
	sections: string[];
} {
	const introLines: string[] = [];
	const sections: string[] = [];
	let current: string[] | null = null;
	// 逐行判断而不是按 "## " 整串 split：`### ` / `#### ` 子标题不以「## + 空格」
	// 开头，不会被误切；围栏代码块内恰以 "## " 开头的行理论上会被误判，但 CHANGELOG
	// 正文不含代码围栏，且误判只影响「哪几行归入哪段」的展示分组，不丢内容。
	for (const line of markdown.split("\n")) {
		if (line.startsWith("## ")) {
			if (current) sections.push(current.join("\n"));
			current = [line];
		} else if (current) {
			current.push(line);
		} else {
			introLines.push(line);
		}
	}
	if (current) sections.push(current.join("\n"));
	return { intro: introLines.join("\n").trim(), sections };
}
