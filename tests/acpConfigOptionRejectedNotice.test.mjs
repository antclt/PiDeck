/**
 * ACP 配置选择失败必须出声（用户反馈：Qoder 选 Bypass Permissions 后 chip 弹回 default，
 * 没有任何解释）。agent 拒绝（Qoder 回 -32603 unknown permission_mode: yolo）与
 * 「切换/关闭瞬间的 IPC 竞态」必须分开：后者静默，前者给带解决方案的提示。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const read = (relativePath) => readFileSync(`${ROOT}/${relativePath}`, "utf8");
const hook = read("src/renderer/src/hooks/useAcpSessionConfig.ts");

test("setOption 失败：agent 拒绝要弹提示，竞态失败保持静默", () => {
	// 提示必须带 agent 的原因；否则用户只看到 chip 弹回，误以为「点了没反应」
	assert.match(hook, /showNotice\(t\("acp\.configOptionRejected", \{ option: optionId, value: String\(value\), reason: errorText\(error\) \}\)/, "拒绝提示必须带 option/value/reason");
	const noticeLine = hook.split("\n").find((line) => line.includes("showNotice("));
	assert.ok(noticeLine, "setOption 失败必须提示");
	assert.match(noticeLine, /undefined,\s*"warning"\)/, "配置没生效用 warning 档，不是 error");
	// 静默只留给 scope 已换（runtime 被替换/关闭）的竞态失败
	const catchBlock = hook.slice(hook.indexOf("const options = await desktopApi.acp.setSessionConfig"));
	assert.match(catchBlock, /if \(scopeRef\.current !== scope \|\| scope\.agentId !== agentId\) return;/, "scope 已换的失败必须静默返回，不能弹提示");
	assert.ok(catchBlock.indexOf("scopeRef.current !== scope") < catchBlock.indexOf("showNotice("), "先判竞态再提示");
	// 传输前缀（Error invoking remote method …）不能原样丢给用户
	assert.match(hook, /replace\(\/\^Error invoking remote method '\[\^'\]\*': \(\?:Error: \)\?\//, "错误文案要去掉 IPC 包装前缀");
});

test("i18n：acp.configOptionRejected 三份词典齐全，且带解决方案", () => {
	const dictionaries = ["zh-CN", "en-US", "zh-TW"].map((locale) => read(`src/renderer/src/i18n/rendererCopy.${locale}.ts`));
	for (const [index, source] of dictionaries.entries()) {
		const locale = ["zh-CN", "en-US", "zh-TW"][index];
		const line = source.split("\n").find((entry) => entry.includes('"acp.configOptionRejected"'));
		assert.ok(line, `${locale} 缺 acp.configOptionRejected`);
		for (const param of ["{option}", "{value}", "{reason}"]) assert.ok(line.includes(param), `${locale} 缺占位符 ${param}`);
		assert.match(line, /--permission-mode bypass_permissions/, `${locale} 必须给出可执行的变通方案`);
	}
});
