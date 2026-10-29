import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * live 流可见性门控（discussion #446）：几百个后台流式会话不该再把 live 正文/思考
 * 灌给渲染层。这里锁住三件事：
 * - 渲染层上报的集合按不可信输入处理（去重/trim/限长/限数量）；
 * - 只有「本次新增可见」的会话需要补帧；
 * - 只有 text-stream / thinking 受门控，messages/state/notice 全量照发。
 */
const { VisibleSessionRegistry, normalizeVisibleSessionIds, shouldDeliverLiveStreamToMainWindow } = loadTsCommonJs("src/main/sessions/visibleSessionRegistry.ts");

test("normalizeVisibleSessionIds：非数组/脏值丢弃，去重、trim、限数量", () => {
	// vm 沙箱返回的数组原型与本 realm 不同：先展开再比。
	assert.deepEqual([...normalizeVisibleSessionIds(undefined)], []);
	assert.deepEqual([...normalizeVisibleSessionIds("session-a")], []);
	assert.deepEqual([...normalizeVisibleSessionIds([1, null, "", "  ", " s1 ", "s1", "s2"])], ["s1", "s2"]);
	assert.deepEqual([...normalizeVisibleSessionIds(["x".repeat(129), "ok"])], ["ok"]);
	const many = Array.from({ length: 40 }, (_, index) => `s${index}`);
	assert.equal(normalizeVisibleSessionIds(many).length, 32);
});

test("VisibleSessionRegistry：只返回本次新增的会话，重复上报不补帧", () => {
	const registry = new VisibleSessionRegistry();
	// 首次上报前 fail-open（启动早期聊天栏还没挂载）：调用方按「未上报 = 全放行」处理。
	assert.equal(registry.hasReported(), false);
	assert.deepEqual([...registry.update(["a", "b"])], ["a", "b"]);
	assert.equal(registry.hasReported(), true);
	assert.equal(registry.isVisible("a"), true);
	assert.deepEqual([...registry.update(["a", "b"])], []);
	assert.deepEqual([...registry.update(["a", "b", "c"])], ["c"]);
	// 移出后再次进入算新增：切回来必须补一帧全量（后台期间没收到增量）。
	assert.deepEqual([...registry.update(["a", "b"])], []);
	assert.deepEqual([...registry.update(["a", "b", "c"])], ["c"]);
	registry.clear();
	assert.equal(registry.isVisible("a"), false);
});

test("shouldDeliverLiveStreamToMainWindow：只裁剪 text-stream / thinking", () => {
	const visible = (sessionId) => sessionId === "visible";
	for (const channel of ["agents:text-stream", "agents:thinking"]) {
		assert.equal(shouldDeliverLiveStreamToMainWindow({ sourceChannel: channel, sessionId: "visible" }, visible), true);
		assert.equal(shouldDeliverLiveStreamToMainWindow({ sourceChannel: channel, sessionId: "hidden" }, visible), false);
	}
	// 历史消息、运行状态、通知与 Ask 请求是侧栏/Tab/提示的输入，不能跟着 live 流一起裁。
	for (const channel of ["agents:message", "agents:state", "agents:runtime-state", "agents:notice", "agents:ui-request"]) {
		assert.equal(shouldDeliverLiveStreamToMainWindow({ sourceChannel: channel, sessionId: "hidden" }, visible), true);
	}
});
