/**
 * 扩展白名单模式（--no-extensions + 逐条 -e 注入）的版本门槛。
 *
 * 门槛依据（来自 pi 官方仓库 README 历史 tag 考证）：
 * - v0.40.0 起 README 已有 `--extension <path>, -e` 与 `--no-extensions`（仅文件路径语义）；
 * - v0.60.0 起 `-e, --extension <source>` 文档化为 "Load extension from path, npm, or git"，
 *   目录 / npm 包源语义正式化——白名单注入的正是这类路径。
 * 因此低于 0.60 的老版本对 -e 目录/包源的行为未定义，可能报 unknown option 或 path not found，
 * 造成 RPC 启动失败；高于等于 0.60 的版本均可安全使用白名单。
 */
export const MIN_PI_MINOR_VERSION_FOR_EXTENSION_WHITELIST = 60;

/**
 * 从 pi 版本串（如 "0.82.1" / "v0.60.0"）解析次版本号；解析失败返回 null（视为版本未知）。
 */
export function parsePiMinorVersion(version: string | null | undefined): number | null {
  if (!version) return null;
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return Number.parseInt(match[2], 10);
}