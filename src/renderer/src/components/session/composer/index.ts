/**
 * Composer 输入子系统出口：类型、chip 纯函数、编辑器视图。
 * 依赖方向：types/chips ← TipTap 实现 ← TipTapComposer；controller 只依赖契约与 caretCoords。
 */

export type { ComposerChip } from "./chips";
export {
	formatFilePathRef,
	parseRichInputChips,
	unwrapFileChipPath,
} from "./chips";
export type { ComposerEditorProps } from "./types";
export { getComposerCaretCoords, getComposerCaretOffset } from "./caretCoords";
export { TipTapComposer, type TipTapComposerProps } from "./TipTapComposer";
