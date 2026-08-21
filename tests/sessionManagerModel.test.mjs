import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = {
		exports: {},
		require: (specifier) => {
			// 本模块只有类型导入，编译后应无运行时 require；出现即测试装载失败。
			throw new Error(`Unexpected import: ${specifier}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/sessionManagerModel.ts"), sandbox, {
		filename: "sessionManagerModel.ts",
	});
	return sandbox.exports;
}

function summary(overrides) {
	return {
		id: overrides.id ?? overrides.filePath ?? "s1",
		filePath: overrides.filePath ?? "",
		name: overrides.name ?? "t",
		preview: "",
		updatedAt: overrides.updatedAt ?? 1,
		messageCount: 1,
		source: overrides.source ?? "pi",
		...overrides,
	};
}

const { isManagerSessionSummary, sessionManagerRowKey, mergeManagerArchived } = loadModule();

test("isManagerSessionSummary: DSH 有 host id 才收录；草稿不收录", () => {
	assert.equal(isManagerSessionSummary(summary({ filePath: "a.jsonl", backend: "pi" })), true);
	assert.equal(isManagerSessionSummary(summary({ filePath: "", backend: "pi" })), false);
	assert.equal(isManagerSessionSummary(summary({ backend: "dsh", dshSessionId: "session-x" })), true);
	assert.equal(isManagerSessionSummary(summary({ backend: "dsh" })), false);
});

test("sessionManagerRowKey: 用稳定记录 id，空 filePath 的 DSH 行不冲突", () => {
	assert.equal(sessionManagerRowKey(summary({ id: "uuid-1", filePath: "" })), "uuid-1");
	assert.equal(sessionManagerRowKey(summary({ id: "uuid-2", filePath: "b.jsonl" })), "uuid-2");
});

test("mergeManagerArchived: pi/DSH 合并并按时间倒序", () => {
	const merged = mergeManagerArchived(
		[summary({ id: "p1", filePath: "a.jsonl", updatedAt: 100 })],
		[{ dshSessionId: "session-x", cwd: "C:\\proj", archivedAt: 200 }],
	);
	// VM 上下文的数组原型与测试 realm 不同，不能 deepEqual；按字符串断言
	assert.equal(merged.map((row) => row.kind).join(","), "dsh,pi");
	assert.equal(merged[0].kind === "dsh" && merged[0].dshSessionId, "session-x");
	assert.equal(merged[1].kind === "pi" && merged[1].session.id, "p1");
});

test("mergeManagerArchived: 空列表返回空数组", () => {
	assert.equal(mergeManagerArchived([], []).length, 0);
});
