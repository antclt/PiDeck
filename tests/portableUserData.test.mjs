/**
 * 正式包装后的 userData 解析：安装版与便携版必须隔离。
 * 便携 exe 若仍落到 %APPDATA%/pi-desktop，同版本单实例锁会让第二次启动静默退出。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	PACKAGED_USER_DATA_NAME,
	PORTABLE_USER_DATA_DIR_NAME,
	resolvePackagedUserDataDir,
} = loadTsCommonJs("src/main/portableUserData.ts");

test("安装版仍用历史 %APPDATA%/pi-desktop", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: {},
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME),
	);
});

test("Windows 便携 exe 落到 exe 同级 data/，不与安装版抢锁", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: { PORTABLE_EXECUTABLE_DIR: "D:\\tools\\phids" },
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("D:\\tools\\phids", PORTABLE_USER_DATA_DIR_NAME),
	);
});

test("非 Windows 忽略 PORTABLE_EXECUTABLE_DIR", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "linux",
			env: { PORTABLE_EXECUTABLE_DIR: "/tmp/phids" },
			appData: "/home/me/.config",
		}),
		join("/home/me/.config", PACKAGED_USER_DATA_NAME),
	);
});

test("主进程正式版走 resolvePackagedUserDataDir，启动失败有 catch", () => {
	const src = readFileSync("src/main/index.ts", "utf8");
	assert.match(src, /from "\.\/portableUserData"/);
	assert.match(src, /resolvePackagedUserDataDir\(\{ appData: app\.getPath\("appData"\) \}\)/);
	assert.match(src, /registerIpc\(\);\s*registerFeishuIpc\(\);\s*await createWindow\(\);/s);
	assert.match(src, /Application startup failed/);
	assert.match(src, /showErrorBox/);
});
