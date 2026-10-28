import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteProjectEntryService } = loadTsCommonJs("src/main/remote/RemoteProjectEntryService.ts");
const fileState = loadTsCommonJs("src/renderer/src/components/session/remoteFileManagementState.ts");

/**
 * v3 计划 §3.1 要把 `files:stat` / `files:pathsExist` 路由到 `entry-stat`。
 *
 * 本用例钉住这条路由会撞上的既有约束（没有 SSH，全部确定性）：
 * 1. `stat` 是**签发令牌的读**（`RemoteProjectEntryService.stat` 末尾 `tokens.issue`，
 *    `RemoteEntryStatResult.version`），不是纯读；
 * 2. entry 令牌表是**全局** FIFO 上限 128（`RemoteFileMutationTokens.MAX_ENTRIES`），
 *    不按 sender / project / 路径分区，也不去重；
 * 3. 因此一次最多 128 目标的 `files:pathsExist` 批量，或两台窗口交替刷新目录，都能把用户
 *    手上那张 rename/delete 令牌按「最旧」挤掉，之后写操作在 `tokens.take` 处报
 *    `REMOTE_FILE_VERSION_INVALID` —— 文件其实没变、远端一条命令都没发出。渲染层又没有这条
 *    码的分支（`remoteFileEntryErrorKey` 落到 default），用户看到的是
 *    「文件操作未获确认（REMOTE_FILE_VERSION_INVALID）」，把「什么都没发生」说成了「结果未知」。
 *
 * 若计划改为「只读 stat 不签发令牌」（或把 stat 令牌放进独立小池），把第 2 个用例的期望
 * 改成 `0` / 令牌仍可用即可；这组断言存在的价值是让那次改动必须显式面对这条压力。
 */
const ROOT = "/srv/project";
const NODE = "/srv/project/.pideck/node";
const REVISION = { mode: 0o644, size: 10, dev: "1", ino: "2", uid: "3", gid: "4", mtimeNs: "5", ctimeNs: "6" };

/** 假会话：从已构造命令里取出 marker（PIDECK_ENTRY_<32hex>），原样回一条合法 stat 结果。 */
function fakeSession() {
	return {
		nodePath: NODE,
		hostRevision: 1,
		async runCommand(command) {
			const marker = /PIDECK_ENTRY_[a-f0-9]{32}/.exec(command)?.[0];
			if (!marker) throw new Error("REMOTE_FILE_COMMAND_FAILED");
			const payload = { ok: true, stat: { kind: "file", bytes: 10, mtimeMs: 1_700_000_000_000 }, revision: REVISION };
			return { exitCode: 0, stdout: `noise\n${marker}${JSON.stringify(payload)}\n` };
		},
	};
}

function service() {
	return createRemoteProjectEntryService({
		locator: (projectId) => (projectId === "proj" ? { hostId: "host", remotePath: ROOT } : undefined),
		withProject: async (_target, work) => work(fakeSession()),
	});
}

test("entry stat 是签发令牌的读：每次调用都新增一张一次性授权", async () => {
	const entries = service();
	const first = await entries.stat(1, "proj", "src/a.ts");
	assert.match(first.version, /^[0-9a-f]{32}$/);
	// 逐字段比较：VM 里加载的模块返回的对象原型与测试进程不同，deepEqual 会因原型不同失败。
	assert.equal(first.stat.kind, "file");
	assert.equal(first.stat.bytes, 10);
	assert.equal(first.stat.mtimeMs, 1_700_000_000_000);
	assert.equal(entries.tokenCount(), 1);
	// 同一路径重复 stat 不复用旧令牌，而是继续追加。
	const second = await entries.stat(1, "proj", "src/a.ts");
	assert.notEqual(second.version, first.version);
	assert.equal(entries.tokenCount(), 2);
});

test("一次 128 目标的 pathsExist 批量会挤掉用户手上的写令牌（文件未变却报 VERSION_INVALID）", async () => {
	const entries = service();
	// 用户打开「重命名」拿到的那张令牌。
	const grant = await entries.stat(1, "proj", "src/a.ts");
	// 等价于 files:pathsExist 的一次批量上限（filesIpc 允许 128 个目标），逐个 stat。
	for (let index = 0; index < 128; index += 1) await entries.stat(1, "proj", `src/f${index}.ts`);
	// 表仍是 128（全局 FIFO），但最早那张授权已经不在表里。
	assert.equal(entries.tokenCount(), 128);
	await assert.rejects(
		() => entries.rename(1, "proj", "src/a.ts", "src/b.ts", grant.version),
		(error) => error.message === "REMOTE_FILE_VERSION_INVALID",
	);
});

test("令牌表不按窗口分区：另一个窗口的目录刷新同样能挤掉本窗口的授权", async () => {
	const entries = service();
	const grant = await entries.stat(1, "proj", "src/a.ts");
	for (let index = 0; index < 128; index += 1) await entries.stat(2, "proj", `docs/g${index}.md`);
	await assert.rejects(
		() => entries.deleteEntry(1, "proj", "src/a.ts", grant.version),
		(error) => error.message === "REMOTE_FILE_VERSION_INVALID",
	);
});

test("令牌失效被说成「结果未获确认」：确定性的拒绝不能冒充 unknown", () => {
	// 令牌被挤掉 / 过期时远端一条命令都没执行，UI 却把这条码归到带「未获确认」字样的兜底文案，
	// 而 unknown 语义只应由 REMOTE_FILE_RESULT_UNCONFIRMED 表达。
	assert.notEqual(fileState.remoteFileEntryErrorKey("REMOTE_FILE_VERSION_INVALID"), "remoteFileEntry.failure");
	assert.equal(fileState.remoteFileEntryErrorKey("REMOTE_FILE_VERSION_INVALID"), "remoteFileEntry.changed");
	assert.equal(fileState.remoteFileEntryKeepsInput("REMOTE_FILE_VERSION_INVALID"), true);
	// unknown 的唯一来源保持唯一。
	assert.equal(fileState.remoteFileEntryIsUnknown("REMOTE_FILE_VERSION_INVALID"), false);
});
