import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { reasoningText } = loadTsCommonJs("src/shared/reasoningText.ts");

/**
 * 思考展示净化（对齐 DSH 0.2.1-rc.5 reasoning-text.ts）。
 * 供应商把思维签名整块拼在推理正文最前面时，界面只能看到正文；签名未闭合期间整行隐藏。
 */

test("无签名：原文直出（含非签名的尖括号内容）", () => {
	assert.equal(reasoningText("普通思考\n第二行"), "普通思考\n第二行");
	assert.equal(reasoningText(""), "");
	// 只看开头：正文中间出现 </signature> 不是签名块
	assert.equal(reasoningText("先说结论\n</signature> 后面还有"), "先说结论\n</signature> 后面还有");
	// 开头的尖括号但不是签名标签：保持原样
	assert.equal(reasoningText("<div>不是签名</div>"), "<div>不是签名</div>");
});

test("完整签名块剥离，并吃掉紧随的换行", () => {
	assert.equal(reasoningText("<signature>abc123</signature>\n真实思考"), "真实思考");
	assert.equal(reasoningText("<signature>abc123</signature>\r\n真实思考\r\n第二行"), "真实思考\r\n第二行");
	// 签名字体内部允许出现任意字符，包括换行；闭合后的连续换行全部吃掉
	assert.equal(reasoningText("<signature>a\nb</signature>\n\n正文"), "正文");
});

test("签名未闭合（流式半截）：返回空串，绝不把签名正文漏到界面", () => {
	assert.equal(reasoningText("<signature>abc123"), "");
	assert.equal(reasoningText("<signature>"), "");
	// 只收到半个开口标签时同样是空（否则界面上会闪一下 <si）
	assert.equal(reasoningText("<"), "");
	assert.equal(reasoningText("<sig"), "");
	assert.equal(reasoningText("<signature"), "");
});

test("只有签名没有正文：清洗后为空，调用方整行隐藏", () => {
	assert.equal(reasoningText("<signature>abc123</signature>"), "");
	assert.equal(reasoningText("<signature>abc123</signature>\n"), "");
	assert.equal(reasoningText("<signature>abc123</signature>\r\n"), "");
});

test("签名剥离后剩余的空白交给调用方 trim 判定（不做语义裁剪）", () => {
	assert.equal(reasoningText("<signature>x</signature>\n  \n"), "  \n");
	assert.equal(reasoningText("<signature>x</signature>\n正文").trim(), "正文");
});
