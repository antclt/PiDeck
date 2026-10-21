import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 输入框模板表合并（W3）：用户目录/项目目录 ∪ pi 运行时模板。
 * 规则：同名正文取运行时（pi 的最终视图），展示元数据沿用本地；运行时独有条目追加。
 */

const { mergeRuntimeTemplates } = loadTsCommonJs("src/renderer/src/utils/templateCatalog.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const local = (name, content, extra = {}) => ({ name, path: `C:/p/${name}.md`, description: `本地 ${name}`, content, scope: "global", enabled: true, ...extra });

test("同名的正文取运行时版本（与 pi 展开结果一致），本地描述保留", () => {
	const merged = mergeRuntimeTemplates([local("commit", "LOCAL-BODY")], [{ name: "commit", content: "RUNTIME-BODY" }]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].content, "RUNTIME-BODY");
	assert.equal(merged[0].description, "本地 commit");
	assert.equal(merged[0].path, "C:/p/commit.md");
});

test("运行时独占的模板被追加（如 npm 包声明的 pi.prompts）", () => {
	const merged = mergeRuntimeTemplates([local("commit", "LOCAL")], [{ name: "parallel-review", content: "---\ndescription: 评审\n---\nREVIEW", description: "评审" }]);
	assert.deepEqual(plain(merged.map((t) => t.name)), ["commit", "parallel-review"]);
	const added = merged.find((t) => t.name === "parallel-review");
	assert.equal(added.path, "");
	assert.equal(added.description, "评审");
});

test("运行时套件里的 argument-hint 被解析出来", () => {
	const merged = mergeRuntimeTemplates([], [{ name: "x", content: "---\nargument-hint: <file>\n---\nBODY" }]);
	assert.equal(merged[0].argumentHint, "<file>");
});

test("运行时为空时原样返回（不复制数组，节省渲染）", () => {
	const base = [local("commit", "LOCAL")];
	assert.equal(mergeRuntimeTemplates(base, []), base);
});

test("本地描述为空时用运行时的描述兜底", () => {
	const merged = mergeRuntimeTemplates([local("commit", "LOCAL", { description: "" })], [{ name: "commit", content: "RT", description: "来自 frontmatter" }]);
	assert.equal(merged[0].description, "来自 frontmatter");
});

test("本地多余模板不被删除（运行时只覆盖同名）", () => {
	const merged = mergeRuntimeTemplates([local("a", "A"), local("b", "B")], [{ name: "b", content: "B2" }]);
	assert.deepEqual(plain(merged.map((t) => t.name)), ["a", "b"]);
	assert.equal(merged[1].content, "B2");
});
