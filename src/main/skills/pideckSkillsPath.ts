import { join } from "node:path";

/**
 * PiDeck 内置技能的落盘目录（相对 pi 的 agent 根）。
 *
 * 为什么不能放 `~/.pi/agent/skills`：那是 pi 的自动发现根，终端里直接启动的
 * `pi`（TUI）也会扫到；而 PiDeck 自带的技能（生图配置、用量查询、环境诊断）
 * 只对桌面端有意义。放在 pi 不自动扫描的目录，由 PiDeck 在 spawn 时用
 * `--skill` 显式注入，TUI 就看不到它们。
 *
 * 目录仍在同一个 agent 根下：WSL 开启时 `configureWsl` 把 home 换成 WSL home，
 * 安装与注入用的是同一份宿主路径，不需要额外同步。
 */
export const PIDECK_BUNDLED_SKILLS_DIR = "pideck-skills";

/** 解析内置技能目录（home = 当前托管的用户 home，WSL 下为宿主侧 home）。 */
export function pideckBundledSkillsDir(home: string): string {
	return join(home, ".pi", "agent", PIDECK_BUNDLED_SKILLS_DIR);
}
