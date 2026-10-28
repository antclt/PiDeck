import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectFileKey, parseFileTreeKey, fileTreeNodeKey, migrateExpandedDirKeys } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

/** 沙箱里造的对象的原型与测试文件不同：比较前复制成本地值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 身份层（v5 W1）：修的是「同一个文件有两个名字」——本机节点用绝对路径当键，远端节点用项目作用域键。
 * 这组用例钉住三件事：键与位置无关、能解析回读写目标、旧键可无损迁移。
 */
test("键 = 项目作用域身份：与磁盘路径无关，可解析回 target", () => {
	const key = projectFileKey({ projectId: "p1", relativePath: "src/main/a.ts" });
	assert.deepEqual(plain(parseFileTreeKey(key)), { projectId: "p1", relativePath: "src/main/a.ts" });
	// 项目根本身（relativePath 为空）也要能还原。
	assert.deepEqual(plain(parseFileTreeKey(projectFileKey({ projectId: "p1", relativePath: "" }))), { projectId: "p1", relativePath: "" });
	// 同一相对路径在不同项目里必须不同键（跨项目不能串）。
	assert.notEqual(projectFileKey({ projectId: "p1", relativePath: "a.ts" }), projectFileKey({ projectId: "p2", relativePath: "a.ts" }));
});

test("解析只认自己的格式：绝对路径与任意字符串都不算键", () => {
	for (const key of ["F:\\PiDeck\\src", "/home/u/app/src", "src/main/a.ts", "", "project:", "relative:src"]) {
		assert.equal(parseFileTreeKey(key), undefined, key);
	}
});

test("fileTreeNodeKey 绝不退回本机绝对路径", () => {
	const local = { name: "a.ts", type: "file", relativePath: "src/a.ts", path: "F:\\PiDeck\\src\\a.ts", target: { projectId: "p1", relativePath: "src/a.ts" } };
	assert.equal(fileTreeNodeKey(local), projectFileKey({ projectId: "p1", relativePath: "src/a.ts" }));
	// 没有 target 的 legacy/预览节点：用相对路径，不用 path（否则身份又按位置漂移）。
	const legacy = { name: "a.ts", type: "file", relativePath: "src/a.ts", path: "F:\\PiDeck\\src\\a.ts" };
	assert.equal(fileTreeNodeKey(legacy), "relative:src/a.ts");
	assert.equal(fileTreeNodeKey(legacy).includes("F:\\"), false);
});

test("旧键迁移：绝对路径换成项目作用域键，深层节点递归覆盖", () => {
	const tree = [
		{ name: "src", type: "directory", relativePath: "src", path: "F:\\app\\src", target: { projectId: "p1", relativePath: "src" }, children: [{ name: "main", type: "directory", relativePath: "src/main", path: "F:\\app\\src\\main", target: { projectId: "p1", relativePath: "src/main" } }] },
		{ name: "a.ts", type: "file", relativePath: "a.ts", path: "F:\\app\\a.ts", target: { projectId: "p1", relativePath: "a.ts" } },
	];
	const old = new Set(["F:\\app\\src", "F:\\app\\src\\main", "project:p1\u0000docs"]);
	const migrated = migrateExpandedDirKeys(tree, old);
	assert.equal(migrated.changed, true);
	assert.deepEqual([...migrated.keys].sort(), [projectFileKey({ projectId: "p1", relativePath: "docs" }), projectFileKey({ projectId: "p1", relativePath: "src" }), projectFileKey({ projectId: "p1", relativePath: "src/main" })].sort());
});

test("迁移幂等：没有旧键时原样返回，且不产生新集合", () => {
	const tree = [{ name: "src", type: "directory", relativePath: "src", path: "F:\\app\\src", target: { projectId: "p1", relativePath: "src" } }];
	const current = new Set([projectFileKey({ projectId: "p1", relativePath: "src" })]);
	const migrated = migrateExpandedDirKeys(tree, current);
	assert.equal(migrated.changed, false);
	assert.equal(migrated.keys, current, "无变化时返回同一个引用，避免无谓的重渲染与写盘");
});
