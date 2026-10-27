// tests/remoteChannelGate.test.mjs
// 远端能力的通道门禁（2026-10-27 用户裁定：只在 dev 通道提供，正式包不启用也不暴露入口）。
// 三个环节都要钉住，缺一条就会漏：
//   1. 判据本身（isDevChannelBuild 的真值表）——写错方向等于正式包带远端、或 dev 包静默没有远端；
//   2. 主进程装配接线（index.ts 的开关 + systemIpc 上报给渲染层的 devBuild）；
//   3. 渲染层入口（侧栏「+ → 远端（SSH）…」与设置「连接」tab）按同一判据不渲染。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function devChannelBuild(packaged, devBuild) {
	const load = createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: devBuild }, stubs: { electron: { app: { isPackaged: packaged } } } });
	return load("src/main/update/channelIdentity.ts").isDevChannelBuild();
}

test("远端门禁判据：未打包运行与 dev 通道包为真，stable 通道包为假", () => {
	// 未打包运行 = npm run dev / Playwright E2E：本机验收与自动化用例都在这条路径上，必须开。
	assert.equal(devChannelBuild(false, false), true, "未打包运行必须开（dev / e2e）");
	assert.equal(devChannelBuild(false, true), true, "未打包且带 dev 标记仍为开");
	// dev 通道安装包（dist:win:dev 等，编译期 __PIDECK_DEV_BUILD__）。
	assert.equal(devChannelBuild(true, true), true, "dev 通道安装包必须开");
	// 正式发布产物：远端关闭，且不再读 PIDECK_REMOTE_EXPERIMENTAL。
	assert.equal(devChannelBuild(true, false), false, "stable 通道安装包必须关");
});

test("主进程与渲染层读同一个判据：index.ts 的开关、systemIpc 上报的 devBuild", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const channelIdentity = readFileSync("src/main/update/channelIdentity.ts", "utf8");
	assert.match(main, /const remoteExperimentEnabled = isDevChannelBuild\(\);/);
	assert.match(main, /import \{[^}]*isDevChannelBuild[^}]*\} from "\.\/update\/channelIdentity";/);
	// 渲染层门禁的唯一数据来源：update:get-channel 的 devBuild 必须就是同一个函数。
	assert.match(systemIpc, /devBuild: isDevChannelBuild\(\)/);
	assert.match(channelIdentity, /export function isDevChannelBuild\(\): boolean \{\s*return !app\.isPackaged \|\| __PIDECK_DEV_BUILD__;/);
});

test("渲染层入口按通道门禁渲染：侧栏「+」的远端项与设置「连接」tab", () => {
	const hook = readFileSync("src/renderer/src/hooks/useRemoteFeatureAvailable.ts", "utf8");
	assert.match(hook, /return useAtomValue\(updateChannelInfoAtom\)\?\.devBuild;/, "入口判据必须直接用 devBuild，不得另造一份判定");

	const addProjectMenu = readFileSync("src/renderer/src/components/sidebar/AddProjectMenu.tsx", "utf8");
	assert.match(addProjectMenu, /const remoteAvailable = useRemoteFeatureAvailable\(\);/);
	assert.match(addProjectMenu, /\{remoteAvailable !== false && \([\s\S]{0,200}?setRemoteOpen\(true\)/, "远端菜单项必须受通道门禁包裹");

	const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	assert.match(settingsModal, /SETTINGS_TAB_LAYOUT\.filter\(\(entry\) => entry\.id !== "connections"\)/, "正式包必须把「连接」tab 从布局里拿掉");
	assert.match(settingsModal, /resolveVisibleSettingsTabs\(hiddenModules, revealedTabs, settingsLayout\)/);
	assert.match(settingsModal, /entry\.tab !== "connections" \|\| remoteAvailable !== false/, "搜索结果不得再给出打不开的「连接」tab");
	assert.match(settingsModal, /activeTab === "connections" && remoteAvailable !== false/, "门禁关闭时不渲染连接 tab 内容");
});
