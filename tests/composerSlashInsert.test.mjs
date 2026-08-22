// 技能 / Prompt 选择器的「插入 /命令」纯函数测试：
// appendSlashCommandToDraft 保证命令 token 与已有草稿不粘连（空格语义），
// 空草稿直接以命令开头，回车即可发送。走真实 TS 源码（同 composerBehavior.test.mjs 模式）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadComposerBehaviorModule() {
	const source = readFileSync("src/renderer/src/composerBehavior.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "composerBehavior.ts",
	});
	return sandbox.exports;
}

const { appendSlashCommandToDraft } = loadComposerBehaviorModule();

test("空草稿：直接以 /命令 开头（回车即可发送）", () => {
	assert.equal(appendSlashCommandToDraft("", "grill-me"), "/grill-me ");
	assert.equal(appendSlashCommandToDraft("   ", "grill-me"), "/grill-me ");
});

test("非空草稿：先补一个空格再接 /命令，不与已有内容粘连", () => {
	assert.equal(
		appendSlashCommandToDraft("帮我审查一下方案", "grill-me"),
		"帮我审查一下方案 /grill-me ",
	);
});

test("草稿尾随空白：trimEnd 后只保留一个分隔空格，不产生双空格", () => {
	assert.equal(
		appendSlashCommandToDraft("帮我审查一下方案   ", "grill-me"),
		"帮我审查一下方案 /grill-me ",
	);
});

test("命令名保持原样（kebab-case 与含空格的技术名）", () => {
	assert.equal(appendSlashCommandToDraft("", "dsh-tool-skill"), "/dsh-tool-skill ");
	assert.equal(appendSlashCommandToDraft("a", "my skill"), "a /my skill ");
});