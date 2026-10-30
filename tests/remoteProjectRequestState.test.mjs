import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRequestGate } = loadTsCommonJs("src/renderer/src/components/session/remoteRequestGate.ts");
const { createLazyDirTreeController } = loadTsCommonJs("src/renderer/src/utils/lazyDirTree.ts");
const { sortRemoteEntries, isRemoteHostNotConnectedCode } = loadTsCommonJs("src/renderer/src/components/session/remoteProjectEntries.ts");
const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
// 目录读取已下沉到 useRemoteFileTree：代次闸门、listed/error 与「失败清空旧条目」都在那里。
const tree = readFileSync("src/renderer/src/hooks/useRemoteFileTree.ts", "utf8");

test("切项目/卸载后，旧代次的迟到结果一律作废", () => {
	const gate = createRequestGate();
	const first = gate.begin();
	assert.equal(gate.isCurrent(first), true);
	// 切项目 = 开启新一代：上一个项目在途的结果必须被丢弃。
	const second = gate.begin();
	assert.equal(gate.isCurrent(first), false);
	assert.equal(gate.isCurrent(second), true);
	// 卸载 = 作废全部在途结果。
	gate.invalidate();
	assert.equal(gate.isCurrent(second), false);
});

test("目录在前文件在后，同类按名字；不修改入参数组", () => {
	const input = [
		{ name: "b.txt", kind: "file" },
		{ name: "z-dir", kind: "directory" },
		{ name: "a.txt", kind: "file" },
		{ name: "a-dir", kind: "directory" },
		{ name: "link", kind: "other" },
	];
	const sorted = sortRemoteEntries(input);
	// 沙箱里返回的数组原型属于另一 realm，先展开到测试侧再比较。
	assert.deepEqual([...sorted.map((entry) => entry.name)], ["a-dir", "z-dir", "a.txt", "b.txt", "link"]);
	assert.deepEqual(
		input.map((entry) => entry.name),
		["b.txt", "z-dir", "a.txt", "a-dir", "link"],
	);
});

test("目录读取按代次丢弃迟到结果，失败与空目录状态可区分", async () => {
	// 同一目录两次读：晚到的旧结果不能盖掉新结果。
	const pending = [];
	const controller = createLazyDirTreeController(
		(dir) =>
			new Promise((resolve) => {
				pending.push({ dir, resolve });
			}),
	);
	const first = controller.load("");
	const second = controller.load("");
	pending[1].resolve({ ok: true, page: { nodes: [{ name: "new", path: "new", relativePath: "new", type: "file" }], revision: 2, generation: "g1" } });
	await second;
	pending[0].resolve({ ok: true, page: { nodes: [{ name: "old", path: "old", relativePath: "old", type: "file" }], revision: 1, generation: "g1" } });
	await first;
	assert.deepEqual(
		controller.getState().nodes.map((node) => node.name),
		["new"],
	);
	assert.equal(controller.getState().listed, true);

	// 失败：listed=false + 稳定错误码；空目录：listed=true + 无错误，两者不能混在一起。
	const failed = createLazyDirTreeController(async () => ({ ok: false, code: "SSH_HOST_DISCONNECTED" }));
	await failed.load("");
	assert.equal(failed.getState().listed, false);
	assert.equal(failed.getState().error, "SSH_HOST_DISCONNECTED");
	assert.equal(failed.getState().nodes.length, 0);

	const empty = createLazyDirTreeController(async () => ({ ok: true, page: { nodes: [], revision: 1, generation: "g1" } }));
	await empty.load("");
	assert.equal(empty.getState().listed, true);
	assert.equal(empty.getState().error, null);
	assert.equal(empty.getState().nodes.length, 0);

	// 面板仍按 listed/error 分离呈现，且不把失败显示成空目录。
	assert.match(panel, /tree\.listed && tree\.error === null && tree\.nodes\.length === 0/);
	assert.match(panel, /tree\.error !== null/);
});

test("主机未连接与路径错误分开说，失败时清掉旧条目", async () => {
	let fail = false;
	const controller = createLazyDirTreeController(async () => (fail ? { ok: false, code: "SSH_HOST_NOT_READY" } : { ok: true, page: { nodes: [{ name: "old", path: "old", relativePath: "old", type: "file" }], revision: 1, generation: "g1" } }));
	await controller.load("");
	assert.equal(controller.getState().nodes.length, 1);
	fail = true;
	await controller.load("");
	assert.equal(controller.getState().nodes.length, 0, "失败后不得继续展示旧条目");
	assert.equal(controller.getState().error, "SSH_HOST_NOT_READY");
	assert.equal(isRemoteHostNotConnectedCode("SSH_HOST_NOT_READY"), true);
	assert.equal(isRemoteHostNotConnectedCode("REMOTE_PROJECT_PATH_INVALID"), false);
	assert.match(panel, /isNotConnectedCode\(tree\.error\) \? t\("project\.remote\.notConnectedHint"\)/);
});

test("面板文案键在中英词典里都存在", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const keys = new Set();
	for (const match of panel.matchAll(/(?<![A-Za-z0-9_$])t\("([^"]+)"\)/g)) keys.add(match[1]);
	assert.ok(keys.size > 5);
	for (const key of keys) {
		assert.ok(zh.includes(`"${key}":`), `缺中文文案 ${key}`);
		assert.ok(en.includes(`"${key}":`), `缺英文文案 ${key}`);
	}
});
