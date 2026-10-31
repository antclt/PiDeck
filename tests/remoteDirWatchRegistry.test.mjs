import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDirWatchRegistry, dirKeysAfterWrite } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
/** 沙箱里造的对象的原型与测试文件不同：比较前复制成本地值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 目录订阅登记表（W6 接线）要挡的是「事件猜错项目」：事件帧只带 watchId，项目归属只能来自登记。
 * 这组用例钉三件事：未登记就忽略、换会话清空、写后失效范围。
 */
test("登记后才认事件；未登记的 watchId 一律忽略", async () => {
	const registry = createDirWatchRegistry();
	await registry.ensure(HOST, { session: 1 }, "p1", async () => "w1");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, "w1")), [{ projectId: "p1", paths: [""] }]);
	assert.equal(registry.scopesForEvent(HOST, "w-unknown"), undefined, "没发起过的 watchId 不得猜项目");
	assert.equal(registry.scopesForEvent("ffffffff-ffff-4fff-8fff-ffffffffffff", "w1"), undefined, "别的 host 不得命中");
});

test("同一项目只订阅一次；helper 不给 id 时静默降级（不登记）", async () => {
	const registry = createDirWatchRegistry();
	let subscriptions = 0;
	const subscribe = async () => {
		subscriptions += 1;
		return "w1";
	};
	const session = { session: 1 };
	await registry.ensure(HOST, session, "p1", subscribe);
	await registry.ensure(HOST, session, "p1", subscribe);
	assert.equal(subscriptions, 1, "同项目重复读根目录不该重复订阅");
	assert.equal(registry.sizeOf(HOST), 1);

	const unsupported = createDirWatchRegistry();
	await unsupported.ensure(HOST, { session: 1 }, "p1", async () => undefined);
	assert.equal(unsupported.sizeOf(HOST), 0, "helper 不支持（没有 id）就不登记");
});

test("换会话清空登记：旧 helper 的 watcher 已经死了，不能再让它们标脏", async () => {
	const registry = createDirWatchRegistry();
	await registry.ensure(HOST, { session: 1 }, "p1", async () => "w1");
	const second = { session: 2 };
	await registry.ensure(HOST, second, "p1", async () => "w2");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, "w2")), [{ projectId: "p1", paths: [""] }]);
	assert.equal(registry.scopesForEvent(HOST, "w1"), undefined, "旧会话的 watchId 必须失效");
	assert.equal(registry.sizeOf(HOST), 1);
});

test("写后失效范围：所在目录 + 父目录（根层只算自己）", () => {
	// 用 join 比较：键里含 NUL，跨 realm 的数组/字符串比较容易被原型差异干扰。
	const key = (path) => `p1${String.fromCharCode(0)}${path}`;
	assert.deepEqual(plain(dirKeysAfterWrite("p1", ["src/a.ts"])).sort(), [key(""), key("src")].sort());
	assert.deepEqual(plain(dirKeysAfterWrite("p1", ["a.ts"])), [key("")]);
	// 两个文件同一目录只算一次。
	assert.deepEqual(plain(dirKeysAfterWrite("p1", ["src/a.ts", "src/b.ts"])).sort(), [key(""), key("src")].sort());
});
