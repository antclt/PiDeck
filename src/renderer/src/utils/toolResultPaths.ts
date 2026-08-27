import { matchPlainFilePaths } from "./filePathLinks.ts";

/**
 * 工具结果（bash/find/grep 纯文本输出）的路径文本级拆分（零依赖，可被 node:test 直接导入）。
 *
 * 与 remarkLinkifyPaths 共用 matchPlainFilePaths：裸路径候选转成「文本段 + 路径段」，
 * 非路径段原样输出，路径段由 ToolResultText 交给 MarkdownLink（存在性校验 + 点击打开 +
 * 死链降级纯文本）。不跑 markdown 解析——bash 输出不是 markdown，`# / * / >` 不能被误解析。
 * 单文件名（无目录分隔符，如 app.ts）不匹配，避免普通词语被误当路径。
 */
export type ToolResultSegment =
	| { type: "text"; value: string }
	| { type: "path"; path: string };

export function splitByPaths(text: string): ToolResultSegment[] {
	const matches = matchPlainFilePaths(text);
	if (matches.length === 0) return [{ type: "text", value: text }];
	const segs: ToolResultSegment[] = [];
	let last = 0;
	for (const m of matches) {
		if (m.start > last) segs.push({ type: "text", value: text.slice(last, m.start) });
		segs.push({ type: "path", path: text.slice(m.start, m.end) });
		last = m.end;
	}
	if (last < text.length) segs.push({ type: "text", value: text.slice(last) });
	return segs;
}