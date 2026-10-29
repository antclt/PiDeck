/**
 * 安全配置 → Web 端投影（WebSecurityProjection.ts）
 *
 * /api/state 与安全等级更新接口共用同一份投影：Web 端只需要「显示/切换等级」
 * 所需字段，工具动作表、bash 正则、目录边界属于安全门的执行契约，不下发。
 * 单一数据源仍是 SecurityStore（AppSettings.securityConfig），投影只做字段裁剪。
 */
import type { SecurityConfig, WebSecurityState } from "../../shared/types";

export function toWebSecurityState(config: SecurityConfig): WebSecurityState {
	return {
		enabled: config.enabled,
		defaultLevelId: config.defaultLevelId,
		levels: config.levels.map((level) => ({
			id: level.id,
			name: level.name,
			description: level.description,
			...(level.builtin ? { builtin: true } : {}),
		})),
		sessionOverrides: { ...config.sessionOverrides },
	};
}
