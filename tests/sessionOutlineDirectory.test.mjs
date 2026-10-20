import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 导轨目录数据面（计划 §6 S4）：活动索引派生用户检查点 + 按需标题。
 * 判定目标：messageIndex 是 activeMessageEntries 坐标、context_edit 移出的条目不出现、
 * 超预算保留首项与最近项并标记 truncated、标题只读一行且截 80 字。
 */

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function entry(type, id, parentId, extra) {
	return JSON.stringify({ type, id, ...(parentId ? { parentId } : {}), timestamp: "2026-01-01T00:00:00.000Z", ...extra });
}

function userEntry(id, parentId, text) {
	return entry("message", id, parentId, { message: { role: "user", content: [{ type: "text", text }] } });
}

function assistantEntry(id, parentId) {
	return entry("message", id, parentId, { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
}

function makeReader() {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: () => [],
		trimMessages: (raw) => raw,
		translate: (key) => String(key),
	});
}

function writeSession(lines) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-outline-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

test("目录只列用户检查点，messageIndex 是活动消息坐标", async () => {
	const file = writeSession([entry("session", "s1", undefined, { cwd: "/repo" }), userEntry("u1", "s1", "第一条提问"), assistantEntry("a1", "u1"), userEntry("u2", "a1", "第二条提问")]);
	const snapshot = await makeReader().readSessionOutline(file);
	assert.equal(snapshot.total, 2);
	assert.equal(snapshot.truncated, false);
	assert.equal(snapshot.entries.map((item) => item.entryId).join(","), "u1,u2");
	assert.equal(snapshot.entries[0].messageIndex, 0);
	assert.equal(snapshot.entries[1].messageIndex, 2, "u2 前面有一条 assistant，坐标必须是活动消息下标");
	assert.equal(snapshot.entries.map((item) => item.turnOrdinal).join(","), "0,1");
});

test("context_edit 移出的用户消息不进目录", async () => {
	const file = writeSession([entry("session", "s1", undefined, { cwd: "/repo" }), userEntry("u1", "s1", "会被删掉"), assistantEntry("a1", "u1"), userEntry("u2", "a1", "保留"), entry("context_edit", "e1", "u2", { targetId: "u1", replacement: null })]);
	const snapshot = await makeReader().readSessionOutline(file);
	assert.equal(snapshot.entries.map((item) => item.entryId).join(","), "u2");
	assert.equal(snapshot.entries[0].turnOrdinal, 0, "剔除后序号重新连续");
});

test("超预算保留首个与最近项，并标记 truncated", async () => {
	const lines = [entry("session", "s1", undefined, { cwd: "/repo" })];
	let parent = "s1";
	for (let index = 0; index < 12; index += 1) {
		lines.push(userEntry(`u${index}`, parent, `问题 ${index}`));
		parent = `u${index}`;
	}
	const file = writeSession(lines);
	const snapshot = await makeReader().readSessionOutline(file, 5);
	assert.equal(snapshot.total, 12);
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.entries.length, 5);
	assert.equal(snapshot.entries[0].entryId, "u0", "首个检查点必须保留");
	assert.equal(snapshot.entries[4].entryId, "u11", "最近检查点必须保留");
});

test("标题按需读一行并截到 80 字", async () => {
	const longText = `这是很长的提问${"啊".repeat(200)}`;
	const file = writeSession([entry("session", "s1", undefined, { cwd: "/repo" }), userEntry("u1", "s1", longText)]);
	const title = await makeReader().readSessionOutlineTitle(file, "u1");
	assert.ok(title);
	assert.ok(title.length <= 81, `标题过长：${title.length}`);
	assert.match(title, /^这是很长的提问/);
	assert.equal(await makeReader().readSessionOutlineTitle(file, "missing"), undefined);
});

test("通道、handler、preload 三处同步", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const handler = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(ipc, /sessionsCatalogReadOutline:\s*"sessions:catalog-read-outline"/);
	assert.match(ipc, /sessionsCatalogReadOutlineTitle:\s*"sessions:catalog-read-outline-title"/);
	assert.match(handler, /ipcMain\.handle\(\s*ipcChannels\.sessionsCatalogReadOutline,/);
	assert.match(preload, /readOutline:\s*\(/);
	assert.match(preload, /readOutlineTitle:\s*\(/);
});
