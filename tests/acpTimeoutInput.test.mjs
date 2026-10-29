/** ACP 超时输入的单位换算回归：分钟/秒少乘或多乘一个 60，只会让看门狗提前或延后十倍触发，真实会话里很难发现。 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	ACP_STALL_TIMEOUT_DEFAULT_MS,
	ACP_STALL_TIMEOUT_SECONDS,
	ACP_TURN_TIMEOUT_DEFAULT_MS,
	ACP_TURN_TIMEOUT_MINUTES,
	acpStallTimeoutPatch,
	acpStallTimeoutText,
	acpTurnTimeoutPatch,
	acpTurnTimeoutText,
} = loadTsCommonJs("src/renderer/src/components/app/settings/acpTimeoutInput.ts");

// 模块在独立 vm 上下文里求值，返回的对象原型与本地 Object 不同，deepEqual 会因引用比较失败；
// 这里只取需要钉住的字段值比较。
const turnMs = (raw) => acpTurnTimeoutPatch(raw)?.acpPromptTurnTimeoutMs;
const stallMs = (raw) => acpStallTimeoutPatch(raw)?.acpPromptStallTimeoutMs;

test("未自定义时输入框显示与主进程一致的默认值", () => {
	assert.equal(acpTurnTimeoutText(undefined), "15");
	assert.equal(acpStallTimeoutText(undefined), "180");
	assert.equal(ACP_TURN_TIMEOUT_DEFAULT_MS, 900_000);
	assert.equal(ACP_STALL_TIMEOUT_DEFAULT_MS, 180_000);
});

test("毫秒 ↔ 输入文本往返稳定", () => {
	assert.equal(acpTurnTimeoutText(30 * 60_000), "30");
	assert.equal(turnMs(acpTurnTimeoutText(30 * 60_000)), 1_800_000);
	assert.equal(acpStallTimeoutText(300_000), "300");
	assert.equal(stallMs(acpStallTimeoutText(300_000)), 300_000);
});

test("回合超时按分钟写盘、静默判定按秒写盘", () => {
	assert.equal(turnMs("45"), 45 * 60_000);
	assert.equal(stallMs("120"), 120 * 1_000);
	assert.equal(turnMs(" 7 "), 7 * 60_000);
});

test("非法输入不产生 patch，区间边界仍接受", () => {
	for (const raw of ["", "   ", "1.5", "-3", "abc", "0", "241", "1e3", "10min"]) {
		assert.equal(acpTurnTimeoutPatch(raw), undefined, `回合超时应拒绝 ${JSON.stringify(raw)}`);
	}
	for (const raw of ["", "9", "1801", "0", "30s"]) {
		assert.equal(acpStallTimeoutPatch(raw), undefined, `静默判定应拒绝 ${JSON.stringify(raw)}`);
	}
	assert.equal(turnMs(String(ACP_TURN_TIMEOUT_MINUTES.min)), ACP_TURN_TIMEOUT_MINUTES.min * 60_000);
	assert.equal(turnMs(String(ACP_TURN_TIMEOUT_MINUTES.max)), ACP_TURN_TIMEOUT_MINUTES.max * 60_000);
	assert.equal(stallMs(String(ACP_STALL_TIMEOUT_SECONDS.min)), ACP_STALL_TIMEOUT_SECONDS.min * 1_000);
	assert.equal(stallMs(String(ACP_STALL_TIMEOUT_SECONDS.max)), ACP_STALL_TIMEOUT_SECONDS.max * 1_000);
});
