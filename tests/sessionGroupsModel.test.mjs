import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionGroupNodes, isSessionGroupsPluginEnabled, projectDirectoryLabel } = loadTsCommonJs("src/renderer/src/components/sidebar/sessionGroupsModel.ts");

const RECORD = (id, projectId, updatedAt) => ({ id, projectId, title: id, updatedAt });
const PROJECT = (id, name, path) => ({ id, name, path });

test("分组引用解析成分组→目录→会话三层树；失效引用丢弃、重复 id 去重", () => {
	const nodes = buildSessionGroupNodes([{ id: "g1", name: "other", color: "blue", createdAt: 1, sessionIds: ["s1", "ghost", "s1", "s2"], dirs: [] }], { s1: RECORD("s1", "p1", 100), s2: RECORD("s2", "p2", 200) }, { p1: PROJECT("p1", "Alpha", "D:\\alpha"), p2: PROJECT("p2", "Beta", "D:\\beta") });
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].total, 2);
	assert.deepEqual([...Array.from(nodes[0].dirs).map((dir) => dir.name)], ["Alpha", "Beta"]);
	assert.deepEqual([...Array.from(nodes[0].dirs[0].sessions).map((session) => session.id)], ["s1"]);
	assert.equal(nodes[0].dirs[0].path, "D:\\alpha");
});

test("组内会话按 updatedAt 降序；组顺序 = groups 原序（用户拖拽顺序）", () => {
	const nodes = buildSessionGroupNodes(
		[
			{ id: "b", name: "B", color: "red", createdAt: 1, sessionIds: ["s1", "s2", "s3"], dirs: [] },
			{ id: "a", name: "A", color: "blue", createdAt: 2, sessionIds: [], dirs: [] },
		],
		{ s1: RECORD("s1", "p1", 1), s2: RECORD("s2", "p1", 30), s3: RECORD("s3", "p1", 10) },
		{ p1: PROJECT("p1", "P", "D:\\p") },
	);
	assert.deepEqual([...Array.from(nodes[0].dirs[0].sessions).map((session) => session.id)], ["s2", "s3", "s1"]);
	assert.deepEqual([...Array.from(nodes.map((node) => node.group.id))], ["b", "a"]);
});

test("项目缺失（已移除）与 noSession 虚拟会话都不进树", () => {
	const nodes = buildSessionGroupNodes([{ id: "g", name: "G", color: "cyan", createdAt: 1, sessionIds: ["s1", "s2"], dirs: [] }], { s1: RECORD("s1", "gone", 1), s2: { ...RECORD("s2", "p1", 2), noSession: true } }, {});
	assert.equal(nodes[0].total, 0);
	assert.equal(nodes[0].dirs.length, 0);
	const label = projectDirectoryLabel(undefined, "gone");
	assert.equal(label.name, "gone");
	assert.equal(label.path, undefined);
});

test("分组插件未启用时侧栏不展示分组的会话", () => {
	const catalog = (plugins) => ({ directory: "", plugins, issues: [] });
	const plugin = (id, enabled) => ({ manifest: { id }, enabled });
	assert.equal(isSessionGroupsPluginEnabled(catalog([plugin("session-groups", true)])), true);
	// 停用 / 代码已变更待重授权（enabled=false）都不算开启。
	assert.equal(isSessionGroupsPluginEnabled(catalog([plugin("session-groups", false)])), false);
	assert.equal(isSessionGroupsPluginEnabled(catalog([plugin("billion-context", true)])), false);
	// catalog 尚未加载（undefined）按关闭处理：fail-closed，避免插件关掉后旧分组先闪一下。
	assert.equal(isSessionGroupsPluginEnabled(undefined), false);
});

test("projectDirectoryLabel：远端项目给远端路径", () => {
	const remote = { id: "r", name: "Remote", locator: { kind: "ssh", remotePath: "/srv/repo" }, path: undefined };
	const label = projectDirectoryLabel(remote, "r");
	assert.equal(label.name, "Remote");
	assert.equal(label.path, "/srv/repo");
});
