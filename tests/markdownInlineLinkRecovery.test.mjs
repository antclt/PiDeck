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
 * CommonMark 的 link destination 不允许裸空格（spec §2.3），解析器整段降级成纯文本，
 * 用户看到原始 `[...](...)` 语法而不是可点击链接。
 *
 * 插件刻意**不对路径形态做任何假设**（不要求扩展名/盘符/括号成对），只按 CommonMark
 * 语法定界。因此断言分两类：
 *   A. 目标含空格 → 一律救回（含未配对括号、无扩展名、UNC 等任意形态）；
 *   B. 明确不该插手 → 代码、行内代码、已解析链接、作者转义的 `\[`、目标无空格。
 */

function run(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkRecoverInlineLinks);
	// 与 streamdown 的调用形态一致：runSync(tree, source)
	return processor.runSync(processor.parse(markdown), markdown);
}

function decodeLink(url) {
	// 插件产出 file:// + 百分号编码的形式（与 remarkLinkifyPaths 同一口径），
	// 断言对比时还原成原始路径，避免测试耦合编码细节。
	if (typeof url !== "string") return url;
	const raw = url.startsWith("file://") ? url.slice(7) : url;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

function linksOf(node, found = []) {
	if (!node || typeof node !== "object") return found;
	if (node.type === "link" && typeof node.url === "string") found.push(node.url);
	if (Array.isArray(node.children)) for (const child of node.children) linksOf(child, found);
	return found;
}

function collectLinks(node, found = []) {
	if (!node || typeof node !== "object") return found;
	if (node.type === "link") found.push({ url: decodeLink(node.url), text: (node.children ?? []).map((c) => c.value ?? "").join("") });
	if (Array.isArray(node.children)) for (const child of node.children) collectLinks(child, found);
	return found;
}

function collectText(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if ((node.type === "text" || node.type === "inlineCode" || node.type === "code") && typeof node.value === "string") out.push(node.value);
	if (Array.isArray(node.children)) for (const child of node.children) collectText(child, out);
	return out;
}

/* ---------- A. 目标含空格：一律救回，不猜形态 ---------- */

test("带空格 Windows 盘符路径：链接被救回且 url 保留原始路径", () => {
	const url = "C:/Program Files (x86)/My App/README.md";
	assert.deepEqual(collectLinks(run(`[README.md](${url})`)), [{ url, text: "README.md" }]);
});

test("一行里多个带空格链接 + 中文括号尾巴：全部救回", () => {
	// 旧实现的坑：目标段被正则一路吃到第二个链接的名字里，两个链接一起消失
	const md = "ITEM_DATABASE.md — 结构化属性\n[items.c](C:/Program Files (x86)/My Game/work/items.c)（5.7 万行，已还原）、[gameplay.c](C:/Program Files (x86)/My Game/work/gameplay.c)";
	const links = collectLinks(run(md));
	assert.equal(links.length, 2);
	assert.equal(links[0].url, "C:/Program Files (x86)/My Game/work/items.c");
	assert.equal(links[1].url, "C:/Program Files (x86)/My Game/work/gameplay.c");
	assert.equal(links[0].text, "items.c");
	assert.equal(links[1].text, "gameplay.c");
	assert.match(collectText(run(md)).join(""), /5\.7 万行，已还原/);
});

test("目标含未配对括号：同样救回（取遇到的第一个 `)`）", () => {
	// 左侧单括号：括号永远无法配对 → 退化为取第一个 `)`（取最后一个会跨过后续链接）
	assert.deepEqual(collectLinks(run("[x](C:/a(b/x.md)")), [{ url: "C:/a(b/x.md", text: "x" }]);
	// 未配对括号 + 空格（两种截断原因叠加）
	assert.deepEqual(collectLinks(run("[x](C:/a(b/my doc.md)")), [{ url: "C:/a(b/my doc.md", text: "x" }]);
	// 多层未闭合
	assert.deepEqual(collectLinks(run("[x](C:/a((b/c d.md)")), [{ url: "C:/a((b/c d.md", text: "x" }]);
	// 关键回归：不成对括号后紧跟第二个链接，不能被吞成一个 target
	assert.deepEqual(collectLinks(run("[a](C:/a(b/c.md) 和 [b](D:/e f.md)")), [
		{ url: "C:/a(b/c.md", text: "a" },
		{ url: "D:/e f.md", text: "b" },
	]);
	// 不成对后跟说明文字：不拖入正文
	assert.deepEqual(collectLinks(run("[a](C:/a(b/c.md) 然后就没有了")), [{ url: "C:/a(b/c.md", text: "a" }]);
});

test("无扩展名、无盘符、各种形态一律救回（不做形态假设）", () => {
	assert.deepEqual(collectLinks(run("[README](C:/Program Files/My App/README)")), [{ url: "C:/Program Files/My App/README", text: "README" }]);
	assert.deepEqual(collectLinks(run("[a](/tmp/some dir/a)")), [{ url: "/tmp/some dir/a", text: "a" }]);
	assert.deepEqual(collectLinks(run("[a](./my chart")), []); // 缺 `)`：不是链接写法，保持原样
	assert.deepEqual(collectLinks(run("[a](./my chart)")), [{ url: "./my chart", text: "a" }]);
	assert.deepEqual(collectLinks(run("[a](../up one/x)")), [{ url: "../up one/x", text: "a" }]);
	assert.deepEqual(collectLinks(run("[a](~/home dir/a)")), [{ url: "~/home dir/a", text: "a" }]);
	assert.deepEqual(collectLinks(run("[a](\\\\\\\\server\\\\share dir\\\\a.md)")), [{ url: "\\\\server\\share dir\\a.md", text: "a" }]);
});

test("反斜杠盘符路径：救回", () => {
	assert.deepEqual(collectLinks(run("[a](C:\\Users\\My Docs\\shot.md)")), [{ url: "C:\\Users\\My Docs\\shot.md", text: "a" }]);
});

test("嵌在正文中间/列表项里的链接同样被救回，且前后文不丢", () => {
	const md = "产物清单：\n- [config.json](C:/Program Files (x86)/My App/config.json) — 机器可读版\n- [notes.md](D:/projects/Docs/notes.md)（5.7 万行）\n";
	const links = collectLinks(run(md));
	assert.equal(links.length, 2);
	assert.equal(links[0].url, "C:/Program Files (x86)/My App/config.json");
	assert.equal(links[1].url, "D:/projects/Docs/notes.md");
	const text = collectText(run(md)).join("");
	assert.match(text, /产物清单：/);
	assert.match(text, /机器可读版/);
});

test("中文目录名带空格：救回", () => {
	assert.deepEqual(collectLinks(run("[设计稿](D:/我的文档/设计稿.md)")), [{ url: "D:/我的文档/设计稿.md", text: "设计稿" }]);
});

test("任意形态一律救回（不做任何路径形态假设）", () => {
	const bs = String.raw`C:\Program Files\x.md`;
	const cases = [
		["多重空格", "[a](C:/a  b   c.txt)", "C:/a  b   c.txt"],
		["括号内含空格", "[a](C:/x (1) y/z.md)", "C:/x (1) y/z.md"],
		["反斜杠盘符", `[a](${bs})`, bs],
		["全角括号", "[a](C:/x（全角）y/z.md)", "C:/x（全角）y/z.md"],
		["无盘符绝对路径", "[a](/home/user/my file.md)", "/home/user/my file.md"],
		["相对路径", "[a](../up dir/file.md)", "../up dir/file.md"],
		["波浪号路径", "[a](~/my dir/file.md)", "~/my dir/file.md"],
	];
	for (const [name, md, url] of cases) {
		assert.deepEqual(collectLinks(run(md)), [{ url, text: "a" }], name);
	}
	// UNC：反斜杠层数会被 CommonMark 的转义规则改写（`\\` → `\`），
	// 不去硬编码层数（那本质上也是在猜），只要求「当做目标完整救回、不被截断」。
	const uncUrl = collectLinks(run("[a](\\\\server\\share dir\\a.md)"))[0]?.url;
	assert.ok(uncUrl, "UNC 路径应当被救回");
	assert.ok(uncUrl.includes("share dir") && uncUrl.endsWith("a.md"), `UNC 目标不被截断：${uncUrl}`);
});

test("相邻两个链接、标签含空格：都救回", () => {
	assert.deepEqual(collectLinks(run("[a](C:/x y/1.md)[b](C:/x y/2.md)")), [
		{ url: "C:/x y/1.md", text: "a" },
		{ url: "C:/x y/2.md", text: "b" },
	]);
	assert.deepEqual(collectLinks(run("[my file.md](C:/x y/z.md)")), [{ url: "C:/x y/z.md", text: "my file.md" }]);
});

/* ---------- B. 明确不该插手 ---------- */

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

test("代码围栏/行内代码里的同样写法不受影响", () => {
	assert.deepEqual(collectLinks(run("```\n[x](C:/Program Files/a b.md)\n```")), []);
	assert.deepEqual(collectLinks(run("`[x](C:/Program Files/a b.md)`")), []);
});

test("label 与目标之间夹空格的写法：CommonMark 也不认，保持原样", () => {
	assert.deepEqual(collectLinks(run("[x] (C:/Program Files/a b.md)")), []);
});

test("目标含尖括号/换行：按规范不构成目标，保持原样", () => {
	assert.deepEqual(collectLinks(run("[x](C:/Program Files/<a> b.md)")), []);
});

/* ---------- C. 手写盘符路径：改写为 file://（sanitize 只放行白名单协议） ---------- */

test("手写盘符路径的 link 统一改写成 file:// 形式", () => {
	// 不带空格的盘符写法能被 CommonMark 正常解析，不走恢复路径；
	// 但裸 `C:/` 会被 rehype-sanitize 当成未知协议 `c:` 剥掉 href（渲染出没有 href 的 <a>）。
	const cases = [
		["正斜杠", "[a](C:/Users/x/a.md)", "C:/Users/x/a.md"],
		["小写盘符", "[a](c:/Users/x/a.md)", "c:/Users/x/a.md"],
		["反斜杠", String.raw`[a](C:\Users\x\a.md)`, String.raw`C:\Users\x\a.md`],
		["已编码空格", "[a](C:/Users/x/a%20b.md)", "C:/Users/x/a b.md"],
	];
	for (const [name, md, expected] of cases) {
		assert.deepEqual(collectLinks(run(md)), [{ url: expected, text: "a" }], name);
	}
	// 实际产出的 url 必须是 file:// 形式（sanitize 白名单里才有 file）
	const raw = linksOf(run("[a](C:/Users/x/a.md)"));
	assert.ok(raw[0]?.startsWith("file://"), `期望 file:// 形式，实际 ${raw[0]}`);
});

test("非盘符形态不受改写影响（相对/POSIX/波浪号/UNC/已 file://）", () => {
	const cases = [
		["相对", "[a](./docs/a.md)", "./docs/a.md"],
		["POSIX", "[a](/home/u/a.md)", "/home/u/a.md"],
		["波浪号", "[a](~/a.md)", "~/a.md"],
		// UNC 在 markdown 源里反斜杠本身是转义符，`\\` 解析后就是一字符 `\`；
		// 这里只断言「不被改写成 file://」（UNC 不含冒号，sanitize 本来就能放行）。
		["UNC", String.raw`[a](\\server\share\a.md)`, String.raw`\server\share\a.md`],
	];
	for (const [name, md, expected] of cases) {
		assert.deepEqual(collectLinks(run(md)), [{ url: expected, text: "a" }], name);
	}
	// 已经是 file:// 的不重复改写
	const already = linksOf(run("[a](file:///C:/Users/x/a.md)"));
	assert.deepEqual(already, ["file:///C:/Users/x/a.md"]);
});
