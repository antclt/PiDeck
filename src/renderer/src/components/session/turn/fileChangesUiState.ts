/**
 * 「本轮修改文件」列表的展示逻辑（纯函数，供 SessionModifiedFilesStrip 与单测共用）。
 */
/** 列表默认最多平铺展示的文件行数；超出后折叠为「展开全部」，避免一轮修改十几个文件时整屏铺满。 */
export const MAX_VISIBLE_FILES = 3;

/** 按偏好与总文件数计算实际展示行数：未展开全部时截断到 MAX_VISIBLE_FILES，展开后全量。 */
export function visibleFileCount(total: number, showAll: boolean): number {
	if (showAll) return total;
	return Math.min(total, MAX_VISIBLE_FILES);
}
