import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 项目登记不再要求用户手打绝对路径：目录浏览器替换输入框，但选中后仍走 canonical 确认。
const dialog = readFileSync("src/renderer/src/components/sidebar/RemoteProjectEnrollDialog.tsx", "utf8");
const picker = readFileSync("src/renderer/src/components/sidebar/RemoteDirectoryPicker.tsx", "utf8");

test("enrollment uses the picker for both existing and create flows", () => {
	assert.doesNotMatch(dialog, /id="remote-enroll-path"/);
	assert.match(dialog, /<RemoteDirectoryPicker key=\{`existing-\$\{state\.hostId\}`\}/);
	assert.match(dialog, /<RemoteDirectoryPicker\s+key=\{`create-\$\{state\.hostId\}`\}/);
	assert.match(dialog, /id="remote-enroll-leaf"/);
	// 新建模式要父目录 + 合法叶名才允许提交。
	assert.match(dialog, /const createPathReady = createParent !== "" && isValidNewLeaf\(leaf\)/);
	assert.match(dialog, /state\.mode === "create" \? !createPathReady : state\.path\.trim\(\) === ""/);
});

test("picker is read-only, bounded and explains the failure modes", () => {
	assert.match(picker, /desktopApi\.remoteHosts\.listDirs\(props\.hostId, target\)/);
	assert.match(picker, /isVisibleRemoteDirectory\(entry\.name, showHidden\)/);
	assert.match(picker, /dirParent/);
	assert.match(picker, /dirTruncated/);
	assert.match(picker, /REMOTE_LIST_DIRS_NOT_A_DIRECTORY/);
	assert.match(picker, /SSH_HOST_NOT_READY/);
	// 不提供写入/读取内容的入口。
	assert.doesNotMatch(picker, /readProject|upload|createDirectory/);
});
