import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * WSL 配置目标（P1-1）输入校验与稳定码闭集。
 *
 * 渲染层传进来的 target 一律不可信：wsl 目标必须恰好两个 key、hostId 走与项目域共用的
 * PROJECT_HOST_ID_PATTERN。不合格的目标必须在任何端口被调用前失败，且只回闭集里的码。
 */

const target = loadTsCommonJs("src/main/config/piConfigTarget.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const HOST = "11111111-1111-4111-8111-111111111111";

function codeOf(run) {
	try {
		run();
		return "ALLOWED";
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
}

test("wsl 目标是合法目标：恰好两个 key、hostId 形状正确", () => {
	const parsed = target.readPiConfigTarget({ kind: "wsl", hostId: HOST });
	assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { kind: "wsl", hostId: HOST });
	assert.deepEqual(JSON.parse(JSON.stringify(target.readPiConfigReadOptions({ target: { kind: "wsl", hostId: HOST } }))), { target: { kind: "wsl", hostId: HOST } });
	// 本地/ssh 语义不变（兼容旧调用）。
	assert.deepEqual(JSON.parse(JSON.stringify(target.readPiConfigTarget(undefined))), { kind: "local" });
	assert.deepEqual(JSON.parse(JSON.stringify(target.readPiConfigTarget({ kind: "ssh", hostId: HOST }))), { kind: "ssh", hostId: HOST });
});

test("不合格的 wsl 目标回 WSL_CONFIG_TARGET_INVALID，不落到本机", () => {
	const invalid = [{ kind: "wsl" }, { kind: "wsl", hostId: "" }, { kind: "wsl", hostId: "not-a-host" }, { kind: "wsl", hostId: HOST, extra: 1 }, { kind: "wsl", hostId: HOST, label: "x" }, { kind: "wsl", hostId: 42 }];
	for (const value of invalid) {
		assert.equal(
			codeOf(() => target.readPiConfigTarget(value)),
			shared.WSL_CONFIG_CODES.targetInvalid,
			JSON.stringify(value),
		);
	}
	// 未知 kind 仍然是共享契约里的 REMOTE_CONFIG_TARGET_INVALID（与 ssh 同口径）。
	assert.equal(
		codeOf(() => target.readPiConfigTarget({ kind: "bogus" })),
		shared.REMOTE_CONFIG_CODES.targetInvalid,
	);
});

test("wsl 保存与本地同语义：整文件写入，不接受 expectedVersion/patch", () => {
	const saved = target.readPiConfigWriteOptions({ target: { kind: "wsl", hostId: HOST } });
	assert.deepEqual(JSON.parse(JSON.stringify(saved)), { target: { kind: "wsl", hostId: HOST } });
	for (const extra of [{ expectedVersion: "c".repeat(64) }, { patch: {} }, { expectedVersion: "c".repeat(64), patch: {} }]) {
		assert.equal(
			codeOf(() => target.readPiConfigWriteOptions({ target: { kind: "wsl", hostId: HOST }, ...extra })),
			shared.WSL_CONFIG_CODES.targetInvalid,
			JSON.stringify(extra),
		);
	}
	// 本地写入语义保持：有 expectedVersion 仍然是 targetInvalid。
	assert.equal(
		codeOf(() => target.readPiConfigWriteOptions({ target: { kind: "local" }, expectedVersion: "c".repeat(64) })),
		shared.REMOTE_CONFIG_CODES.targetInvalid,
	);
});

test("WSL 稳定码是闭集，且与共享契约逐条对齐", () => {
	const expected = ["WSL_CONFIG_TARGET_INVALID", "WSL_CONFIG_HOST_NOT_FOUND", "WSL_CONFIG_DISTRO_UNAVAILABLE", "WSL_CONFIG_PATH_UNREADABLE", "WSL_CONFIG_FILE_INVALID", "WSL_CONFIG_UNSUPPORTED", "WSL_CONFIG_UNAVAILABLE"];
	assert.deepEqual(Object.values(shared.WSL_CONFIG_CODES).sort(), [...expected].sort());
	for (const code of expected) assert.ok(shared.WSL_CONFIG_CODE_SET.has(code), code);
	// 渲染层从 IPC 错误里抓码：Electron 会给 message 加前缀，抓取必须容忍。
	const error = new Error("Error invoking remote method 'config:get-models': Error: WSL_CONFIG_HOST_NOT_FOUND");
	assert.equal(shared.wslPiConfigCodeFromError(error), "WSL_CONFIG_HOST_NOT_FOUND");
	assert.equal(shared.wslPiConfigCodeFromError(new Error("REMOTE_CONFIG_TARGET_INVALID")), undefined);
	// 快照判别只看主进程写下的 kind，不从本地数据推断。
	assert.equal(shared.isWslPiConfigSnapshot({ kind: "wsl", hostId: HOST }), true);
	assert.equal(shared.isWslPiConfigSnapshot({ kind: "remote", hostId: HOST }), false);
	assert.equal(shared.isWslPiConfigSnapshot(undefined), false);
});
