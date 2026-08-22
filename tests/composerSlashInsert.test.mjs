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

const { appendSlashCommandToDraft, toSkillInvocationToken } = loadComposerBehaviorModule();
const controller = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);
const skillPicker = readFileSync(
  "src/renderer/src/components/session/ComposerSkillPicker.tsx",
  "utf8",
);

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

test("技能调用 token 按后端分形：pi 用 /skill:名称，DSH 用裸名称", () => {
	assert.equal(toSkillInvocationToken("pi", "grill-me"), "skill:grill-me");
	assert.equal(toSkillInvocationToken("dsh", "grill-me"), "grill-me");
	// 插入草稿后得到的完整命令（pi 形态经 appendSlashCommandToDraft 拼成 /skill:名称）
	assert.equal(
		appendSlashCommandToDraft("", toSkillInvocationToken("pi", "grill-me")),
		"/skill:grill-me ",
	);
	assert.equal(
		appendSlashCommandToDraft("", toSkillInvocationToken("dsh", "grill-me")),
		"/grill-me ",
	);
});

test("技能名与 pi 内建命令同名时不冲突（/skill: 前缀隔离命令空间）", () => {
	// 例如技能名叫 review，不与 pi 的 /review 类命令抢名字；pi 技能命令空间是 skill:*。
	assert.equal(toSkillInvocationToken("pi", "review"), "skill:review");
	// 而 DSH 由宿主 dsh-tool-skill 把技能注册成裸命令，同名时宿主负责冲突仲裁。
	assert.equal(toSkillInvocationToken("dsh", "review"), "review");
});

test("insertSkillInvocation 与技能面板展示都走后端感知的 token（单一来源）", () => {
	// controller：插入用 isDshBackend 决定形态，避免把 /skill:名 插进 DSH、把裸名插进 pi
	assert.match(controller, /toSkillInvocationToken\(isDshBackend \? "dsh" : "pi", name\)/);
	// 面板：选项标签与搜索词同步展示 /skill:名称（pi） / 名称（DSH）
	assert.match(skillPicker, /toSkillInvocationToken\(props\.backend, skill\.name\)/);
	assert.match(skillPicker, /keywords=\{\[skill\.name, skill\.description, skill\.whenToUse \?\? "",/);
});