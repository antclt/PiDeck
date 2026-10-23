/**
 * 工具语义化短语生成器（学 Proma tool-phrase.ts）。
 *
 * 将工具名 + 参数合成为一句连贯、可读的中文短语，用于工具卡收起态展示，
 * 替代直接显示完整命令行——折叠态更轻、更易扫读。
 *
 * 2026-10 对齐 ZCode 过程行排版：短语拆成「动词 + 作用对象」两段——
 * 动词做 trigger 行主标签（界面字体），对象进等宽 chip 单行截断预览。
 *
 * 纯函数、无运行时依赖（node 单测直接加载）。
 */
import { parseToolArgs } from "../../app/AppUtils";

/** 从路径中提取文件名（兼容 POSIX `/` 与 Windows `\` 分隔符） */
function filename(path: string): string {
	return path.split(/[/\\]/).pop() || path;
}

/** 截断文本 */
function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + "…" : text;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
		if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
			return value[0];
		}
	}
	return undefined;
}

function pickPath(input: Record<string, unknown>): string | undefined {
	return firstString(input.file_path, input.filePath, input.path, input.file, input.target, input.destination, input.dest_path);
}

export interface ToolPhrase {
	/** 完成态/收起态短语（`动词 + 空格 + 对象` 拼接），供组头摘要等整句消费者 */
	label: string;
	/** Loading 态短语，如「正在读取 foo.ts...」 */
	loadingLabel: string;
	/** 人类动词（「读取」「执行」…）：工具行主标签，界面字体 */
	verb: string;
	/** 作用对象（文件名/命令/URL…）：进等宽 chip 预览，视觉单行截断；无对象时缺省 */
	object?: string;
}

/** 组装 ToolPhrase：label 固定为「动词 对象」拼接，保持整句消费者的产出不变 */
function phraseFor(verb: string, object: string | undefined, loadingVerb: string): ToolPhrase {
	return {
		verb,
		object,
		label: object ? `${verb} ${object}` : verb,
		loadingLabel: object ? `${loadingVerb} ${object}...` : `${loadingVerb}...`,
	};
}

/**
 * 根据工具名和输入参数生成语义化短语。
 * 内置工具走中文动宾短语；未知/扩展工具回退为 `工具名 参数摘要`。
 */
export function getToolPhrase(toolName: string, input: Record<string, unknown> = {}): ToolPhrase {
	const key = toolName.toLowerCase();
	const path = pickPath(input);
	const file = path ? filename(path) : undefined;

	// 文件读取/编辑/写入类。无对象时动词回退为完整动宾（「读取文件」），
	// 行内不能只剩光杆动词——那会比旧短语更少信息量。
	if (key === "read") {
		if (!file) return phraseFor("读取文件", undefined, "正在读取文件");
		const range = firstString(input.offset, input.start_line) !== undefined ? `（${firstString(input.offset, input.start_line)} 行起）` : "";
		return phraseFor("读取", `${file}${range}`, "正在读取");
	}
	if (key === "edit" || key === "multi_edit") {
		return file ? phraseFor("编辑", file, "正在编辑") : phraseFor("编辑文件", undefined, "正在编辑文件");
	}
	if (key === "write" || key === "create") {
		return file ? phraseFor("写入", file, "正在写入") : phraseFor("写入文件", undefined, "正在写入文件");
	}

	// bash / shell 命令
	if (key === "bash" || key === "shell" || key === "run") {
		const command = firstString(input.command, input.cmd);
		return phraseFor("执行", command, "正在执行");
	}

	// 搜索类
	if (key === "grep" || key === "search") {
		const pattern = firstString(input.pattern, input.query, input.q);
		return phraseFor("搜索", pattern, "正在搜索");
	}
	if (key === "glob" || key === "find") {
		const pattern = firstString(input.pattern, input.glob, input.query);
		return phraseFor("查找", pattern, "正在查找");
	}

	// 网络获取类
	if (key === "fetch" || key === "fetch_content" || key === "web_search" || key === "url" || key === "http" || key.includes("fetch")) {
		const url = firstString(input.url, input.urls, input.query);
		return phraseFor("获取", url, "正在获取");
	}

	// 待办/清单类
	if (key === "todo" || key === "todolist" || key === "task") {
		const action = firstString(input.action, input.text);
		return phraseFor("待办", action, "正在更新待办");
	}

	// 图片/附件
	if (key === "image" || key === "vision" || key.includes("image")) {
		return phraseFor("查看图片", file, "正在查看图片");
	}

	// 通用/扩展/MCP 工具：回退到「工具名 参数摘要」
	const paramSummary = firstString(input.command, input.cmd, input.pattern, input.query, input.url, input.file_path, input.filePath, input.path);
	const displayName = toolName || "工具";
	return phraseFor(displayName, paramSummary ? truncate(String(paramSummary), 60) : undefined, `正在${displayName}`);
}

/** 兼容旧签名：接收 ChatMessage，内部解析 args（给 ToolCard 直接用）。 */
export function getToolPhraseFromArgs(toolName: string, args: unknown): ToolPhrase {
	const parsed = parseToolArgs(args);
	return getToolPhrase(toolName, parsed ?? {});
}
