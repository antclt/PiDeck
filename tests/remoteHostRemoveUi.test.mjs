import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 连接列表必须能移除连接；删除是破坏性动作，要有确认框、可行动的错误说明，
// 成功后清掉该主机的本地视图状态。

const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");

test("each host row offers a confirmed removal", () => {
	assert.match(tab, /settings\.connections\.remove"\)/);
	assert.match(tab, /setRemoving\(host\)/);
	assert.match(tab, /<Dialog[\s\S]{0,200}?open=\{removing !== null\}/);
	assert.match(tab, /variant="destructive"/);
	assert.match(tab, /desktopApi\.remoteHosts\.remove\(hostId\)/);
});

test("removal refusal is explained, not just coded", () => {
	assert.match(tab, /code === "REMOTE_HOST_REFERENCED"/);
	assert.match(tab, /settings\.connections\.remove\.referenced/);
	assert.match(tab, /settings\.connections\.remove\.needsRepair/);
	// 成功后才清本地状态；失败保留列表与错误说明。
	assert.match(tab, /if \(!result\.ok\) \{\s*setRemoveError\(removeErrorText\(result\.code\)\);\s*return;/);
	assert.match(tab, /delete next\[hostId\]/);
});
