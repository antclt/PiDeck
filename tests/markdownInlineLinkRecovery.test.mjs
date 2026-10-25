import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkRecoverInlineLinks } from "../src/renderer/src/utils/markdownRecoverInlineLinks.ts";

/**
 * `remarkRecoverInlineLinks` 回归。
 *
 * 触发场景：AI 在会话里引用本地文件时常写
 *   `[README.md](C:/Program Files (x86)/My App/README.md)`
 * CommonMark 的链接目标不允许裸空格/未配对括号，解析器整段降级成纯文本，用户看到的是
 * 原始 `[...](...)` 语法而不是可点击链接。
 *
 * 插件只在「解析器确实拆坏了」时动手，其余情况必须零改动——一旦放宽，正文里的
 * `[说明](示例)` 文字、代码围栏、带括号的路径都会被改写成链接。
 */

function run(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkRecoverInlineLinks);
	// 与 streamdown 的调用形态一致：runSync(tree, source) —— 插件靠 file.value 判断作者是否写了转义
	return processor.runSync(processor.parse(markdown), markdown);
}

function collectLinks(node, found = []) {
	if (!node || typeof node !== "object") return found;
	if (node.type === "link") found.push({ url: node.url, text: (node.children ?? []).map((c) => c.value ?? "").join("") });
	if (Array.isArray(node.children)) for (const child of node.children) collectLinks(child, found);
	return found;
}

function collectText(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if ((node.type === "text" || node.type === "inlineCode" || node.type === "code") && typeof node.value === "string") out.push(node.value);
	if (Array.isArray(node.children)) for (const child of node.children) collectText(child, out);
	return out;
}

test("带空格 Windows 盘符路径：链接被救回且 url 保留原始路径", () => {
	const url = "C:/Program Files (x86)/My App/README.md";
	assert.deepEqual(collectLinks(run(`[README.md](${url})`)), [{ url, text: "README.md" }]);
});

test("嵌在正文中间/列表项里的链接同样被救回，且前后文不丢", () => {
	const links = collectLinks(run("产物清单：\n- [config.json](C:/Program Files (x86)/My App/config.json) — 机器可读版\n- [notes.md](D:/projects/Docs/notes.md)（5.7 万行）\n"));
	assert.equal(links.length, 2);
	assert.equal(links[0].url, "C:/Program Files (x86)/My App/config.json");
	assert.equal(links[1].url, "D:/projects/Docs/notes.md");
	// 命中前后的正文必须完整保留
	const text = collectText(run("产物清单：\n- [config.json](C:/Program Files (x86)/My App/config.json) — 机器可读版\n")).join("");
	assert.match(text, /产物清单：/);
	assert.match(text, /机器可读版/);
});

test("反斜杠盘符、POSIX 绝对路径、./ 相对路径同样被救回", () => {
	assert.deepEqual(collectLinks(run("[a](C:\\Users\\My Docs\\shot.md)")), [{ url: "C:\\Users\\My Docs\\shot.md", text: "a" }]);
	assert.deepEqual(collectLinks(run("[a](/tmp/some dir/a.md)")), [{ url: "/tmp/some dir/a.md", text: "a" }]);
	assert.deepEqual(collectLinks(run("[a](./charts/my chart.md)")), [{ url: "./charts/my chart.md", text: "a" }]);
});

test("没有空格的正常写法本来就解析成功，插件零改动", () => {
	const links = collectLinks(run("[x](C:/Program Files/x.md)"));
	assert.equal(links.length, 1);
	assert.equal(links[0].url, "C:/Program Files/x.md");
});

test("作者写了转义：保持纯文本，不救", () => {
	const tree = run("\\[x](C:/Program Files/x.md)");
	assert.deepEqual(collectLinks(tree), []);
	assert.equal(collectText(tree).join(""), "[x](C:/Program Files/x.md)");
});

test("目标含尖括号/协议相对写法：歧义太大，不救", () => {
	assert.deepEqual(collectLinks(run("[x](C:/Program Files/<a> b.md)")), []);
	assert.deepEqual(collectLinks(run("[x](//example.com/a b.md)")), []);
});

test("远程 URL 带空格不在处理范围（交给浏览器语义）", () => {
	// CommonMark 原生就会在第一个空格处截断目标：`https://example.com/a` 成为链接、
	// `b.md)` 变纯文本——这是规范行为，本插件不应「修好」它（远程 URL 交给浏览器）。
	// 关键断言：救回的 url 绝不能是带空格的完整 URL。
	const links = collectLinks(run("[x](https://example.com/a b.md)"));
	assert.ok(
		links.every((l) => !l.url.includes(" ")),
		"不应产出带空格的 URL",
	);
	assert.deepEqual(
		collectLinks(run("[x](file:///C:/a b.md)")).filter((l) => l.url.includes(" ")),
		[],
	);
});

test("代码围栏/行内代码里的同样写法不受影响", () => {
	assert.deepEqual(collectLinks(run("```\n[x](C:/Program Files/a b.md)\n```")), []);
	assert.deepEqual(collectLinks(run("`[x](C:/Program Files/a b.md)`")), []);
});

test("相对裸文件名无法区分正文词组，不救", () => {
	assert.deepEqual(collectLinks(run("[x](a b.md)")), []);
});

test("括号滑到正文的半截写法：不救", () => {
	// `[x](/tmp/a b)（备注）`：目标匹配会在第一个 ) 处停下，剩下的全角括号
	// 说明已经从路径滑进正文，括号配对校验必须拒掉。
	assert.deepEqual(collectLinks(run("[x](/tmp/a b)（备注）")), []);
});

test("中文目录名带空格：救回", () => {
	const links = collectLinks(run("[设计稿](D:/我的文档/设计稿.md)"));
	assert.deepEqual(links, [{ url: "D:/我的文档/设计稿.md", text: "设计稿" }]);
});

test("正文里裸露的 [词](某 些 词) 不会被误改成链接", () => {
	// 无强前缀、末段无扩展名 → 判定不像本地路径，保持纯文本
	const links = collectLinks(run("写法示例 [词](某 些 词) 就是这样"));
	assert.deepEqual(links, []);
});
