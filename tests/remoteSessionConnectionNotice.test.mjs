import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 会话页此前只显示 trust 条（资源加载），主机掉线没有任何提示。
// 这里锁定：只对 ssh 会话渲染、只读共享主机状态、重连走 main，不在本地伪造 online。

const notice = readFileSync("src/renderer/src/components/session/RemoteSessionConnectionNotice.tsx", "utf8");
const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");

test("remote session surfaces host disconnection in the session view", () => {
	assert.match(notice, /record\?\.locator\?\.kind === "ssh" \? record\.locator\.hostId : undefined/);
	assert.match(notice, /remoteHostIdentityIndexAtom/);
	assert.match(notice, /resolveRemoteHostConnectionTone\(identity\.state\)/);
	assert.match(notice, /if \(tone === "online"\) return null;/);
	assert.match(view, /<RemoteSessionConnectionNotice sessionId=\{sessionId\} \/>/);
});

test("reconnect calls main and never fakes success", () => {
	assert.match(notice, /desktopApi\.remoteHosts\.connect\(hostId\)/);
	assert.match(notice, /if \(!result\.ok\) setErrorCode\(result\.code\);/);
	assert.match(notice, /session\.remoteConnection\.reconnectFailed/);
	// 连接中由状态推送驱动，按钮不重复发起。
	assert.match(notice, /\{connecting \? null : \(/);
});
