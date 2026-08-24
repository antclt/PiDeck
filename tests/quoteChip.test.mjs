import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	createQuoteTokenRe,
	buildQuoteToken,
	createQuoteId,
	extractQuoteTokens,
	stripQuoteTokens,
	expandQuoteTokens,
	truncateQuoteLabel,
	buildDraftWithAppendedQuote,
	pruneUnreferencedQuotes,
} = loadTsCommonJs(
	"src/renderer/src/components/session/composer/quoteChip.ts",
);

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较（同 composerChips.test.mjs）。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const snippet = (id, text) => ({ id, text, messageId: "m1", createdAt: 0 });

test("token regex matches #q<hex> with safe boundaries", () => {
	const re = createQuoteTokenRe();
	const text = "看 #qabcdef12 和 x#q111111、##q222222、#q333333g 与 #q444444，";
	const ids = [...text.matchAll(re)].map((m) => m[1]);
	// x 前缀（\w）与 ## 双井号不命中；尾随字母 g 回溯失败不命中；中文标点后正常命中
	assert.deepEqual(ids, ["qabcdef12", "q444444"]);
});

test("buildQuoteToken / createQuoteId keep the same shape as the regex body", () => {
	const id = createQuoteId();
	assert.match(id, /^q[0-9a-f]{8}$/);
	assert.equal(buildQuoteToken(id), `#${id}`);
	assertJsonEqual(
		extractQuoteTokens(`前文 ${buildQuoteToken(id)} 后文`).map((o) => o.id),
		[id],
	);
});

test("extractQuoteTokens reports occurrences with offsets in order", () => {
	const text = "#qaaaaaa01 中间 #qbbbbbb02 再提 #qaaaaaa01";
	const tokens = extractQuoteTokens(text);
	assertJsonEqual(
		tokens.map((t) => [t.id, t.start, t.end]),
		[
			// token 长度 = 1(#)+1(q)+8(hex) = 10，偏移必须与文本严格对齐（caret 映射依赖）
			["qaaaaaa01", 0, 10],
			["qbbbbbb02", 14, 24],
			["qaaaaaa01", 28, 38],
		],
	);
});

test("stripQuoteTokens removes tokens and cleans leftover spaces", () => {
	assert.equal(stripQuoteTokens("#qaaaaaa01 为什么"), "为什么");
	assert.equal(stripQuoteTokens("为什么 #qaaaaaa01 不生效"), "为什么 不生效");
	assert.equal(stripQuoteTokens("没有引用的普通消息"), "没有引用的普通消息");
});

test("expandQuoteTokens returns null when no token present", () => {
	assert.equal(expandQuoteTokens("普通问题", () => undefined), null);
});

test("expandQuoteTokens preserves quote-question order and dedupes repeated ids", () => {
	const text = "#qbbbbbb02 问题二 #qaaaaaa01 问题一 #qbbbbbb02 补充";
	const expanded = expandQuoteTokens(text, (id) =>
		snippet(id, `${id} 内容`),
	);
	assert.equal(
		expanded,
		"> qbbbbbb02 内容\n\n问题二\n\n> qaaaaaa01 内容\n\n问题一\n\n补充",
	);
});

test("expandQuoteTokens drops orphan tokens silently", () => {
	const expanded = expandQuoteTokens(
		"#qdeadbeef 加上正文",
		() => undefined,
	);
	assert.equal(expanded, "加上正文");
});

test("expandQuoteTokens keeps multi-line structure with > placeholders", () => {
	const expanded = expandQuoteTokens(
		"#qaaaaaa01 这段为什么错",
		() => snippet("qaaaaaa01", "\n第一行\n\n第三行\n"),
	);
	assert.equal(expanded, "> 第一行\n>\n> 第三行\n\n这段为什么错");
});

test("expandQuoteTokens with only quotes yields blockquote-only message", () => {
	const expanded = expandQuoteTokens("#qaaaaaa01", () =>
		snippet("qaaaaaa01", "只有引用"),
	);
	assert.equal(expanded, "> 只有引用");
});

test("truncateQuoteLabel uses first non-empty line and truncates", () => {
	assert.equal(truncateQuoteLabel("\n  \n第二行内容"), "第二行内容");
	assert.equal(truncateQuoteLabel("短"), "短");
	assert.equal(
		truncateQuoteLabel("一".repeat(40)),
		`${"一".repeat(18)}…`,
	);
});

test("buildDraftWithAppendedQuote appends with spacing and trims tail", () => {
	assert.equal(buildDraftWithAppendedQuote("", "#qaaaaaa01"), "#qaaaaaa01 ");
	assert.equal(buildDraftWithAppendedQuote("为什么   ", "#qaaaaaa01"), "为什么 #qaaaaaa01 ");
});

test("pruneUnreferencedQuotes keeps only ids present in the draft", () => {
	const map = {
		qaaaaaa01: snippet("qaaaaaa01", "a"),
		qbbbbbb02: snippet("qbbbbbb02", "b"),
	};
	const kept = pruneUnreferencedQuotes(map, new Set(["qbbbbbb02"]));
	assertJsonEqual(Object.keys(kept), ["qbbbbbb02"]);
});
