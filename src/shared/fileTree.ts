/**
 * 文件树深度/规模契约（主进程与渲染层共用，避免两侧魔数漂移）。
 *
 * 两套读取语义共用同一个上限：
 * - 抽屉默认浅层 listing：maxDepth 0 只拉根层，展开时逐层懒加载；
 * - composer @ 引用整树搜索需要较深深度，才能覆盖 src/main/java/… 这类
 *   深路径（Java/Maven 包层级可达 11+ 层）。渲染层请求、主进程 clamp 同一常量。
 */
export const DEFAULT_FILE_TREE_MAX_DEPTH = 8;
export const FILE_TREE_ABSOLUTE_MAX_DEPTH = 12;
/** 单层直接子项上限：超大目录（数万文件）一次 IPC 会拖垮渲染进程。 */
export const FILE_TREE_MAX_DIRECTORY_ENTRIES = 2000;
