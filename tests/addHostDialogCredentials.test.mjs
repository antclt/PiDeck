import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 手动添加 SSH 主机曾只有「名称/地址/端口」：用户名与私钥只能靠先写 ~/.ssh/config 再回来扫描。
// 主进程的 add 契约本来就接受 user/identityFile，这里锁定渲染层把这两个入口真正接上，
// 且不假装支持密码认证（OpenSSH 调用固定 BatchMode=yes / NumberOfPasswordPrompts=0）。

const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("manual add exposes username and private key", () => {
	assert.match(dialog, /useState\(\{ label: "", hostName: "", port: "", user: "", identityFile: "" \}\)/);
	assert.match(dialog, /id="remote-host-user"/);
	assert.match(dialog, /id="remote-host-identity"/);
	// 私钥路径不做渲染层展开：~ 由主进程规范化；这里只提交原样文本。
	assert.match(dialog, /const identityFile = manual\.identityFile\.trim\(\);/);
	assert.match(dialog, /\.\.\.\(user\.length > 0 \? \{ user \} : \{\}\)/);
	assert.match(dialog, /\.\.\.\(identityFile\.length > 0 \? \{ identityFile \} : \{\}\)/);
});

test("no password field is offered while the transport refuses it", () => {
	assert.doesNotMatch(dialog, /type="password"/);
	assert.match(dialog, /settings\.connections\.add\.credentialsHint/);
});
