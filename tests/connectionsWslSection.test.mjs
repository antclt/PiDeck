import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 第 10 步：连接页列出 WSL 档案并可在新增弹窗里创建；删除只删本机档案，引用时拒绝。
const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("connections page lists WSL profiles on Windows only", () => {
	assert.match(tab, /const wslSupported = detectRendererPlatform\(\) === "win32"/);
	assert.match(tab, /\{wslSupported \? \(/);
	assert.match(tab, /listWslHosts\(\)/);
	assert.match(tab, /settings\.connections\.wsl\.badge/);
	assert.match(tab, /host\.distro\} · \{host\.user/);
});

test("WSL profiles are created from the add dialog, not the dev settings", () => {
	assert.match(dialog, /initialKind\?: ConnectionKind/);
	assert.match(dialog, /useState<ConnectionKind>\(props\.initialKind \?\? "ssh"\)/);
	assert.match(dialog, /id="wsl-host-distro"/);
	assert.match(dialog, /id="wsl-host-user"/);
	assert.match(dialog, /addWslHost\(\{ label, distro, user \}\)/);
	// 不再深链到「设置 → 开发」。
	assert.doesNotMatch(dialog, /openSettings\(\{ tab: "dev" \}\)/);
});

test("removal is confirmed and explains reference refusal", () => {
	assert.match(tab, /removeWslHost\(removingWsl\.id\)/);
	assert.match(tab, /WSL_HOST_REFERENCED/);
	assert.match(tab, /wsl\.remove\.referenced/);
	assert.match(tab, /settings\.connections\.wsl\.remove\.body/);
});
