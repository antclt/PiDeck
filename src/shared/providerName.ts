/**
 * 供应商名称校验（跨进程纯契约：renderer 新增/重命名入口 + main 迁移兜底共用）。
 *
 * 为什么需要严格白名单：provider name 经 DSH `credentialRefFor` 转成
 * `<NAME 大写>-→_>_API_KEY` 作为环境变量名注入 host 进程。
 * POSIX 环境变量名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`，因此 provider name
 * 只能含字母数字/下划线/连字符且字母开头——否则 DSH 读不到密钥、配置 key
 * 在 shell 场景也易被转义。该规则仅用于「新增/重命名」入口，历史数据
 * 迁移走 main 侧更宽松的 isSafeProviderName（仅防路径穿越），不互相卡。
 */

/** 名称长度上限（与 main 侧 isSafeProviderName 一致）。 */
export const PROVIDER_NAME_MAX_LENGTH = 80;

/**
 * 合法 provider name 规则：
 * - 字母开头（保证 credentialRefFor 后环境变量名不以数字开头）
 * - 仅含字母数字 / 下划线 / 连字符
 * - 长度 1–80
 */
const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;

/** 判断是否为合法的新建/重命名 provider name（已 trim）。 */
export function isValidProviderName(name: string): boolean {
	return typeof name === "string" && PROVIDER_NAME_PATTERN.test(name.trim());
}

/** 校验提示文案的 i18n key（renderer 侧 inline 提示用）。 */
export const PROVIDER_NAME_RULE_I18N_KEY = "config.providerNameRule";
