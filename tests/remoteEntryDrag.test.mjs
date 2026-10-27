/**
 * 拖放路由与本机 IO 有界等待（纯函数行为）。
 *
 * 这两处都曾有「源码正则测过、行为没测」的版本，而它们恰好是最容易悄悄错的地方：
 * 内部拖动被当成上传会去读一个不存在的本机路径；本机 IO 无上限会让界面永久停在「上传中」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { remoteDropRoute, remoteDropOnBlankArea, moveDestination, REMOTE_ENTRY_DRAG_TYPE } = loadTsCommonJs("src/renderer/src/utils/remoteEntryDrag.ts");
const { withLocalIoTimeout, createLocalIoBudget, parseLocalUploadPaths, LOCAL_IO_TIMEOUT_CODE, LOCAL_FILE_IO_TIMEOUT_MS, LOCAL_IO_BATCH_BUDGET_MS, REMOTE_UPLOAD_MAX_FILES } = loadTsCommonJs("src/main/ipc/remoteUploadPaths.ts");

test("拖放路由：内部标记走移动，本机文件走上传，其余忽略", () => {
	assert.equal(remoteDropRoute({ hasEntryMarker: true, hasFiles: false }), "move");
	assert.equal(remoteDropRoute({ hasEntryMarker: false, hasFiles: true }), "upload");
	assert.equal(remoteDropRoute({ hasEntryMarker: false, hasFiles: false }), "ignore");
	// 两者同时出现（理论上不会）时按内部处理，绝不去读本机路径。
	assert.equal(remoteDropRoute({ hasEntryMarker: true, hasFiles: true }), "move");
	// 落在空白区域：内部拖动不是移动（由行/面包屑处理），也不触发上传。
	assert.equal(remoteDropOnBlankArea("move"), true);
	assert.equal(remoteDropOnBlankArea("upload"), false);
	assert.equal(remoteDropOnBlankArea("ignore"), false);
	assert.equal(REMOTE_ENTRY_DRAG_TYPE, "application/x-pideck-remote-entry");
});

test("移动落点：同目录/空名返回 null，跨目录拼出目标路径", () => {
	assert.equal(moveDestination("a/b.txt", ""), "b.txt");
	assert.equal(moveDestination("a/b.txt", "c"), "c/b.txt");
	assert.equal(moveDestination("a/b.txt", "a"), null, "拖到当前目录没有意义");
	assert.equal(moveDestination("b.txt", ""), null, "根目录的条目拖到根目录没有意义");
	assert.equal(moveDestination("", "c"), null);
	// 目录之间的移动同样适用（服务端会拒绝拖进自己的子目录，这里不重复判断）。
	assert.equal(moveDestination("a/dir", "b"), "b/dir");
});

test("本机 IO 超时：不返回的 promise 会被稳定码打断，并清掉定时器", async () => {
	const started = Date.now();
	await assert.rejects(withLocalIoTimeout(new Promise(() => {}), 20), new RegExp(LOCAL_IO_TIMEOUT_CODE));
	assert.ok(Date.now() - started < 2_000, "必须真的提前结束");
	// 正常结束的 promise 原样透传结果。
	assert.equal(await withLocalIoTimeout(Promise.resolve(42), 1_000), 42);
	// 非法上限不改变语义（直接透传，不制造 0ms 超时）。
	assert.equal(await withLocalIoTimeout(Promise.resolve("ok"), 0), "ok");
});

test("本机 IO 超时：真实错误优先于超时（不被盖成超时码）", async () => {
	await assert.rejects(withLocalIoTimeout(Promise.reject(new Error("ENOENT")), 1_000), /ENOENT/);
});

test("超时后底层迟到的 rejection 不会变成 unhandledRejection", async () => {
	let late;
	const never = new Promise((_resolve, reject) => {
		late = reject;
	});
	await assert.rejects(withLocalIoTimeout(never, 10), new RegExp(LOCAL_IO_TIMEOUT_CODE));
	// 超时之后底层才失败：race 已 settle，这次 reject 必须被它吞掉而不是冒到进程级。
	assert.equal(typeof late, "function");
	late(new Error("late failure"));
	await new Promise((resolve) => setImmediate(resolve));
});

test("批级预算：耗尽后剩余项立即失败，不会各等一个单条上限", () => {
	const budget = createLocalIoBudget(50);
	assert.equal(budget.exhausted(), false);
	budget.spend(30);
	assert.equal(budget.exhausted(), false);
	budget.spend(budget.remaining());
	assert.equal(budget.exhausted(), true);
	assert.equal(budget.remaining(), 0);
	// 扣超过剩余也只是归零，不会变负。
	const over = createLocalIoBudget(10);
	over.spend(999);
	assert.equal(over.remaining(), 0);
});

test("预算常量是有限值（0/Infinity 等于没有保护）", () => {
	assert.ok(Number.isSafeInteger(LOCAL_FILE_IO_TIMEOUT_MS) && LOCAL_FILE_IO_TIMEOUT_MS > 0 && LOCAL_FILE_IO_TIMEOUT_MS <= 120_000);
	assert.ok(Number.isSafeInteger(LOCAL_IO_BATCH_BUDGET_MS) && LOCAL_IO_BATCH_BUDGET_MS >= LOCAL_FILE_IO_TIMEOUT_MS);
});

test("拖放路径解析仍然只收本机绝对路径（超时逻辑不放宽边界）", () => {
	assert.equal(parseLocalUploadPaths(["/tmp/a.txt"]).ok, true);
	assert.equal(parseLocalUploadPaths(["tmp/a.txt"]).ok, false);
	assert.equal(parseLocalUploadPaths(Array.from({ length: REMOTE_UPLOAD_MAX_FILES + 1 }, (_, i) => `/tmp/${i}`)).ok, false);
});
