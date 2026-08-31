/**
 * rewind checkpoint 常量（移植自 pi-rewind core.ts，MIT）。
 *
 * 与 pi-rewind 保持一致：ref 命名空间、过滤阈值、忽略目录全部对齐，
 * 保证 PiDeck 与 pi CLI 场景下创建的 checkpoint 互相可读——同一仓库里
 * 谁打的点都能被另一方列出/恢复，这是 refs 存储（而非内存存储）的收益。
 */

/** 空树/无 HEAD 时的占位 SHA（git 空树对象固定哈希）。 */
export const ZEROS = "0".repeat(40);

/** checkpoint 的 git ref 命名空间（refs/pi-checkpoints/<id>）。 */
export const REF_BASE = "refs/pi-checkpoints";

/**
 * 未跟踪文件快照大小上限：>10MiB 跳过。
 * 为什么设上限：大文件（模型权重、日志、二进制产物）进 git 对象库会让
 * checkout 与 GC 变慢，且恢复时也可能被 git clean 误删（见 safeClean 的保护逻辑）。
 */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 未跟踪目录文件数上限：>=200 个文件跳过整目录。
 * 目录级跳过是为了避免 node_modules 之类的巨型目录被逐文件 add 拖垮快照。
 */
export const MAX_UNTRACKED_DIR_FILES = 200;

/** 单会话 checkpoint 保留上限，超出裁剪最旧（before-restore 安全网除外）。 */
export const DEFAULT_MAX_CHECKPOINTS = 50;

/**
 * 快照忽略目录（匹配路径任意段；与 pi-rewind 同源）。
 * 依赖/构建产物目录即使没被 .gitignore 覆盖（如 env 目录），也不进快照。
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	".venv",
	"venv",
	"env",
	".env",
	"dist",
	"build",
	".pytest_cache",
	".mypy_cache",
	".cache",
	".tox",
	"__pycache__",
]);

/** 会改动文件系统、值得打 checkpoint 的工具（对齐 pi-rewind）。 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);
