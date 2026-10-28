import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionGroupStore, readSessionGroupsFromPluginStorage } = loadTsCommonJs("src/main/sessionGroups/sessionGroupStore.ts");

/** VM 上下文里产出的数组与宿主 Array 原型不同，先快照成宿主对象再 deepEqual。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 与生产装配同构的临时目录：<userData>/session-groups.json + 插件私有 storage 文件。 */
const roots = [];
async function makeRoot() {
	const root = await mkdtemp(join(tmpdir(), "session-groups-test-"));
	roots.push(root);
	return {
		storePath: join(root, "session-groups.json"),
		pluginStoragePath: join(root, "host-plugin-storage", "session-groups.json"),
	};
}
after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const GROUP = (overrides = {}) => ({ id: "g1", name: "other", color: "blue", createdAt: 100, sessionIds: ["s1", "s2"], dirs: [], ...overrides });

test("save 无 id 生成 id；字段按白名单收窄（去重/裁名/非法色回退）", async () => {
	const { storePath } = await makeRoot();
	const store = new SessionGroupStore(storePath);
	await store.load();
	const groups = await store.save({ name: "  other  ", color: "not-a-color", sessionIds: ["s1", "s1", "", "s2"], dirs: ["d1", 42, "d1"] });
	assert.equal(groups.length, 1);
	const group = plain(groups[0]);
	assert.ok(group.id.length > 10);
	assert.equal(group.name, "other");
	assert.equal(group.color, "blue");
	assert.deepEqual(group.sessionIds, ["s1", "s2"]);
	assert.deepEqual(group.dirs, ["d1"]);
	// 空名拒绝
	await assert.rejects(() => store.save({ name: "   " }), /invalid-session-group/);
});

test("save 已知 id 按位替换（保持显示顺序），未知 id 追加到尾", async () => {
	const { storePath } = await makeRoot();
	const store = new SessionGroupStore(storePath);
	await store.load();
	await store.save(GROUP({ id: "a", name: "A" }));
	await store.save(GROUP({ id: "b", name: "B" }));
	await store.save(GROUP({ id: "a", name: "A2", sessionIds: ["s9"] }));
	const groups = plain(await store.list());
	assert.deepEqual(
		groups.map((group) => group.name),
		["A2", "B"],
	);
	assert.deepEqual(groups[0].sessionIds, ["s9"]);
});

test("delete / reorder：未知 id 容错，未列出的组按原序追加", async () => {
	const { storePath } = await makeRoot();
	const store = new SessionGroupStore(storePath);
	await store.load();
	await store.save(GROUP({ id: "a", name: "A" }));
	await store.save(GROUP({ id: "b", name: "B" }));
	await store.save(GROUP({ id: "c", name: "C" }));
	assert.equal(await store.delete("ghost"), false);
	assert.equal(await store.delete("b"), true);
	const reordered = plain(await store.reorder(["c", "a", "ghost"]));
	assert.deepEqual(
		reordered.map((group) => group.id),
		["c", "a"],
	);
});

test("落盘往返：坏文件按空列表重建；migratedAt 只写一次", async () => {
	const { storePath } = await makeRoot();
	const store = new SessionGroupStore(storePath);
	await store.load();
	await store.save(GROUP({ id: "a", name: "A" }));
	// 坏文件重建
	await writeFile(storePath, "{ truncated", "utf8");
	const reloaded = new SessionGroupStore(storePath);
	await reloaded.load();
	assert.equal((await reloaded.list()).length, 0);
	// 第一次 load 已写 migratedAt，之后不再触发迁移重试（也没有插件文件可迁）。
	const raw = JSON.parse(await readFile(storePath, "utf8"));
	assert.equal(typeof raw.migratedAt, "number");
});

test("启动时一次性迁移插件 v2 storage（含分片键），不删旧文件、不重复导入", async () => {
	const { storePath, pluginStoragePath } = await makeRoot();
	await mkdir(join(pluginStoragePath, ".."), { recursive: true });
	await writeFile(
		pluginStoragePath,
		JSON.stringify({
			"ws.meta": {
				v: 2,
				groups: [
					{ id: "g1", name: "other", color: "green", createdAt: 5, dirs: ["D:\\x"] },
					{ id: "g2", name: "chunked", color: "red", createdAt: 6, dirs: [] },
				],
				collapsed: ["g1"],
			},
			"ws.g.g1": { ids: ["s1", "s2"] },
			"ws.g.g2": { chunked: 2 },
			"ws.g.g2.0": { ids: ["s3"] },
			"ws.g.g2.1": { ids: ["s4", "s4"] },
		}),
		"utf8",
	);
	const store = new SessionGroupStore(storePath, pluginStoragePath);
	await store.load();
	let groups = plain(await store.list());
	assert.deepEqual(
		groups.map((group) => group.id),
		["g1", "g2"],
	);
	assert.deepEqual(groups[0].sessionIds, ["s1", "s2"]);
	assert.deepEqual(groups[0].dirs, ["D:\\x"]);
	assert.deepEqual(groups[1].sessionIds, ["s3", "s4"]);
	// 插件旧文件保留（回退旧版不丢分组）
	assert.ok(JSON.parse(await readFile(pluginStoragePath, "utf8"))["ws.meta"]);
	// 新实例再 load 不重复导入
	const second = new SessionGroupStore(storePath, pluginStoragePath);
	await second.load();
	await second.delete("g1");
	const afterDelete = new SessionGroupStore(storePath, pluginStoragePath);
	await afterDelete.load();
	groups = plain(await afterDelete.list());
	assert.deepEqual(
		groups.map((group) => group.id),
		["g2"],
	);
});

test("readSessionGroupsFromPluginStorage：坏输入返回 null（调用方记 migratedAt 后不再重试）", () => {
	assert.equal(readSessionGroupsFromPluginStorage(null), null);
	assert.equal(readSessionGroupsFromPluginStorage({}), null);
	assert.equal(readSessionGroupsFromPluginStorage({ "ws.meta": { groups: "nope" } }), null);
	const groups = plain(readSessionGroupsFromPluginStorage({ "ws.meta": { groups: [{ id: "x", name: "X" }] }, "ws.g.x": { ids: ["s1"] } }));
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].sessionIds, ["s1"]);
});
