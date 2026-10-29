/**
 * 文件树「加载中...」占位卡死修复测试。
 *
 * 背景：展开目录的 children 拉取失败（目录被删/权限/超上限）或被代次丢弃时，
 * 节点保持「无 children 且 hasChildren=true」，FileNode 的占位分支
 * （expanded && hasChildren !== false && !node.children）永久成立，
 * 「加载中...」文本叠在文件名区域不消失。
 *
 * 修复三件套：
 * 1. markFileTreeLoadFailed：失败目录 hasChildren 置 false，占位立刻消失；
 * 2. toggleDirectory / drillCompactChain 失败路径调用打标（静态接线断言）；
 * 3. restoreExpandedDirs：打开抽屉时对「已展开 + 无 children + 未标失败」目录
 *    按需补拉（父目录先补），无待修复目录时返回 false。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { markFileTreeLoadFailed, mergeFileTreeChildren, fileTreeNodeKey } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

/** 键是项目作用域身份（W1）：目录节点的 `path` 仍在，但不再当键用。 */
const PROJECT = "p1";
const relOf = (path) => path.replace(/^\/p\//, "");
const targetOf = (path) => ({ projectId: PROJECT, relativePath: relOf(path) });
const k = (node) => fileTreeNodeKey(node);

function dir(name, path, children, hasChildren = true) {
	return { name, path, relativePath: relOf(path), target: targetOf(path), type: "directory", children, hasChildren };
}

function file(name, path) {
	return { name, path, relativePath: relOf(path), target: targetOf(path), type: "file" };
}

test("markFileTreeLoadFailed 在顶层目录打标且不触碰 children", () => {
	const tree = [dir("src", "/p/src")];
	const next = markFileTreeLoadFailed(tree, k(tree[0]));
	assert.equal(next[0].hasChildren, false);
	// children 保持 undefined（未加载），占位分支因此不再成立。
	assert.equal(next[0].children, undefined);
	// 原树不被修改（纯函数）。
	assert.equal(tree[0].hasChildren, true);
});

test("markFileTreeLoadFailed 递归命中嵌套目录", () => {
	const tree = [dir("src", "/p/src", [dir("deep", "/p/src/deep")])];
	const next = markFileTreeLoadFailed(tree, k(tree[0].children[0]));
	assert.equal(next[0].children[0].hasChildren, false);
	// 父层不受影响。
	assert.equal(next[0].hasChildren, true);
});

test("markFileTreeLoadFailed 目录不存在时节点引用原样保留", () => {
	const tree = [dir("src", "/p/src", [file("a.ts", "/p/src/a.ts")])];
	// 任意不存在的键：不命中任何节点。
	const next = markFileTreeLoadFailed(tree, "project:p1\u0000other");
	// map 重建数组但未命中节点复用引用（避免无谓重建，与 compactMiddlePackages 同约定）。
	assert.equal(next[0], tree[0]);
	assert.equal(next.length, 1);
});

test("打标后重新 merge 成功结果可恢复（重试入口语义）", () => {
	let tree = [dir("src", "/p/src")];
	// 第一次展开失败 → 打标
	tree = markFileTreeLoadFailed(tree, k(tree[0]));
	assert.equal(tree[0].hasChildren, false);
	// 用户重试成功 → children 写入且 hasChildren 恢复为真实值
	tree = mergeFileTreeChildren(tree, k(tree[0]), [file("a.ts", "/p/src/a.ts")]);
	assert.equal(tree[0].hasChildren, true);
	assert.equal(tree[0].children.length, 1);
});

test("接线：展开失败由 lazyDirTree 清空该层，占位不会永久停留", () => {
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const core = readFileSync("src/renderer/src/utils/lazyDirTree.ts", "utf8");
	// toggle / 折叠中间包都交给 controller；失败路径统一在 controller 里把该层置空（children=[]），
	// hasChildren !== false 的永久「加载中...」占位因此不会出现。
	assert.match(app, /controller\.toggle\(relative\)/);
	assert.match(app, /controller\.drill\(start/);
	assert.match(core, /failed\.add\(dir\)/);
	assert.match(core, /hasChildren: false/);
	assert.match(core, /error = result.code/);
});

test("接线：restoreExpandedDirs 只补读已展开但尚未落地的目录", () => {
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const fn = app.match(/const restoreExpandedDirs = useCallback\(\s*async \(projectId: string\): Promise<boolean> => \{[\s\S]*?\},\s*\[[^\]]*\],?\s*\);/);
	assert.ok(fn, "restoreExpandedDirs should exist");
	const body = fn[0];
	// controller 记录 expanded 与已落地目录；loadMissing 只补未加载项，失败仍是显式 error，不是假成功。
	assert.match(body, /controller\.loadMissing\(\[\.\.\.controller\.getState\(\)\.expanded\]\)/);
	assert.match(body, /isLocalProjectId\(projectId\)/);
	const core = readFileSync("src/renderer/src/utils/lazyDirTree.ts", "utf8");
	assert.match(core, /if \(children\.has\(dir\) && !failed\.has\(dir\)\) continue;/);
});

test("接线：打开文件抽屉先自愈，无待修复目录才静默 refreshFiles", () => {
	// 抽屉切换语义已迁入 useSessionFileLinks（App 只接线）
	const app = readFileSync("src/renderer/src/hooks/workspace/useSessionFileLinks.ts", "utf8");
	const block = app.match(/void restoreExpandedDirs\(activeProjectId\)\.then\(\(repaired\) => \{[\s\S]{0,200}?\}\);/);
	assert.ok(block, "drawer-open path should run restoreExpandedDirs");
	assert.match(block[0], /if \(!repaired\) void refreshVisibleFiles\(activeProjectId, true\)/);
});

test("接线：FileNode 占位独立成行并带 spinner，失败档不显示占位", () => {
	// 行组件已从 WorkspaceSurface 整块迁到独立模块（> 600 行红线）：占位分支断言读新宿主
	const surface = readFileSync("src/renderer/src/components/session/FileTreeRows.tsx", "utf8");
	// 占位分支条件不变（hasChildren !== false 挡住失败档）。
	assert.match(surface, /expanded && node\.hasChildren !== false && !node\.children/);
	// 占位使用 spinner + 独立 flex 行，不再依赖外层文本容器（旧实现是纯文本 div）。
	const placeholder = surface.match(/\{expanded && node\.hasChildren !== false && !node\.children && \(\s*<div className="file-children[^"]*">[\s\S]{0,400}?\)\}/);
	assert.ok(placeholder, "placeholder block should exist");
	assert.match(placeholder[0], /animate-pideck-spin/);
	assert.match(placeholder[0], /t\("drawer\.lazyLoading"\)/);
	// chevron 改按 expanded 显式旋转（受控 Collapsible 的 data-state 时序不可靠）。
	assert.match(surface, /expanded \? "rotate-90" : "rotate-0"/);
});
