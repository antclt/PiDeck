import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 第 11 步：添加项目按所选 WSL 档案登记 distro/user/hostId，入口在连接页；旧的全局路径保留但不再新增语义。
const shared = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const ipc = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
const store = readFileSync("src/main/projects/ProjectStore.ts", "utf8");
const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");

test("add-wsl channel is wired through shared, preload and main", () => {
	assert.match(shared, /projectsAddWsl:\s*"projects:add-wsl"/);
	assert.match(preload, /addWsl:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.projectsAddWsl/);
	assert.match(ipc, /ipcMain\.handle\(ipcChannels\.projectsAddWsl/);
});

test("main resolves the profile instead of reading global WSL settings", () => {
	assert.match(ipc, /createWslHostStore\(userDataDir\)/);
	assert.match(ipc, /resolveWslEnvironment\(profile\.distro, profile\.user\)/);
	assert.match(ipc, /chooseAndAdd\("wsl", environment, \{ hostId: profile\.id, distro: profile\.distro, user: profile\.user \}\)/);
	// 项目保存显式身份；旧 add() 保留兼容。
	assert.match(store, /wslIdentity\?: WslProjectIdentity/);
	assert.match(store, /wslHostId: wslIdentity\.hostId/);
});

test("connections page adds a project from the WSL profile row", () => {
	assert.match(tab, /desktopApi\.projects\.addWsl\(host\.id\)/);
	assert.match(tab, /settings\.connections\.wsl\.addProject/);
});
