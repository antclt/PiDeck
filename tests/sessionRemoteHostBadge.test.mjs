import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 会话页头部原先只给项目名：从侧栏切进远端会话后，界面上再没有「跑在哪台机器」的线索。
// 这里锁定：远端项目才追加主机标签，复用侧栏同一份目录/状态与配色，不复制第二套状态源。

const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
const tag = readFileSync("src/renderer/src/components/sidebar/RemoteProjectHostTag.tsx", "utf8");

test("session header shows the host badge only for remote projects", () => {
	assert.match(header, /import \{ isRemoteProject \} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/projectLocation";/);
	assert.match(header, /import \{ RemoteProjectHostTag \} from "\.\.\/sidebar\/RemoteProjectHostTag";/);
	assert.match(header, /\{project !== undefined && isRemoteProject\(project\) \? <RemoteProjectHostTag hostId=\{project\.locator\.hostId\} testId="session-remote-host" className="max-w-32" \/> : null\}/);
	// 本机会话不能凭空出现主机标签
	assert.doesNotMatch(header, /RemoteProjectHostTag[\s\S]{0,120}isLocalProject/);
});

test("host badge keeps one status source and supports a distinct test id", () => {
	assert.match(tag, /testId\?: string/);
	assert.match(tag, /data-testid=\{props\.testId \?\? "remote-project-host"\}/);
	assert.match(tag, /resolveRemoteHostConnectionTone\(identity\.state\)/);
	assert.match(tag, /REMOTE_HOST_TONE_DOT_CLASS\[tone\]/);
	// 目录还没到时整体不渲染：头部不能先闪一个空白/假状态。
	assert.match(tag, /if \(identity === undefined\) return null;/);
});
