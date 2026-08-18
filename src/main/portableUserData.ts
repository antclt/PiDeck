import { join } from "node:path";

/**
 * 正式版 userData 目录名。
 * 安装版继续用历史 %APPDATA%/pi-desktop，避免改名后读不到旧 settings/projects。
 */
export const PACKAGED_USER_DATA_NAME = "pi-desktop";

/** 便携版把数据放在 exe 同级 data/，与安装版隔离。 */
export const PORTABLE_USER_DATA_DIR_NAME = "data";

export type PackagedUserDataInput = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	appData: string;
};

/**
 * 解析正式包装后的 userData。
 * Windows 便携 exe 由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR；
 * 若仍落到安装版同一目录，同版本单实例锁会让第二次启动静默退出（表现为「点了没反应」）。
 */
export function resolvePackagedUserDataDir(input: PackagedUserDataInput): string {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const portableDir = env.PORTABLE_EXECUTABLE_DIR?.trim();
	if (platform === "win32" && portableDir) {
		return join(portableDir, PORTABLE_USER_DATA_DIR_NAME);
	}
	return join(input.appData, PACKAGED_USER_DATA_NAME);
}
