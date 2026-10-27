import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 设置 → 连接的空态原先只有一句「还没有已登记的主机」+ 底部按钮；
// 现在给一个能直接行动的引导卡，并避免与底部主按钮重复。

const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("empty connections state is an actionable card", () => {
	assert.match(tab, /settings\.connections\.emptyTitle/);
	assert.match(tab, /settings\.connections\.emptyHint/);
	assert.match(tab, /border-dashed/);
	// 卡内主按钮与列表底部按钮不同时出现：空态只有卡里的一个「添加」。
	assert.match(tab, /\{hosts\.length > 0 \? \(\s*<Button variant="default" size="sm" onClick=\{\(\) => setAdding\(true\)\}>/);
});

test("WSL in the add dialog creates a profile instead of deep-linking", () => {
	assert.match(dialog, /addWslHost\(\{ label, distro, user \}\)/);
	assert.match(dialog, /kind === "wsl" \? \(/);
	assert.match(dialog, /id="wsl-host-distro"/);
	// WSL 页不再渲染 SSH 表单或提交按钮。
	assert.match(dialog, /\{kind === "ssh" \? \(\s*<Button disabled=\{busy\} onClick=\{\(\) => void submit\(\)\}>/);
});
