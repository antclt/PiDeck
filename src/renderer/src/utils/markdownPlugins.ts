import remarkGfm, { type Options as RemarkGfmOptions } from "remark-gfm";
import type { Plugin, Pluggable } from "unified";

/**
 * 会话/静态 markdown 渲染统一使用的 GFM 插件。
 *
 * 关闭单波浪线删除线（remark-gfm 默认 singleTilde: true；GitHub/CommonMark 只用 `~~`）：
 * AI 输出与文件内容里常见的 `~` 路径会被 `~text~` 单波形误判成删除线，
 * 例如 Windows 8.3 短路径 `C:\Users\ADMINI~1\...` 会被从 `~` 处劈开，
 * 后续 remarkLinkifyPaths 只能拿到 `\AppData\...` 这类残缺路径 → 点击打开空文件。
 * `~~...~~` 双波形删除线语义不受影响（与 GitHub 行为对齐）。
 */
const gfmPlugin = remarkGfm as unknown as Plugin<[RemarkGfmOptions?]>;

/** [plugin, options] 元组形态（与 streamdown defaultRemarkPlugins.gfm 同形），可放进 remarkPlugins 列表 */
export const remarkGfmNoSingleTilde: Pluggable = [gfmPlugin, { singleTilde: false }];