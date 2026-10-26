/**
 * 源码契约判据的共用工具（不是测试文件：文件名不带 `.test.`，`npm test` 的 glob 不会加载它）。
 *
 * 为什么要有这一层：这些测试读的是 `.tsx` 源码字符串（没有 JSX 运行时，起不了真渲染），
 * 于是判据本身极容易被廉价绕过。2026-10 审计用变异实验抓到两个真实绕过面：
 *
 * 1. **注释冒充**：把 `<Collapsible open={!collapsed}>` 或 `useComposerWidgetCollapsed(` 挪进
 *    注释，组件运行时已不再走那条路径，测试照样全绿。→ `stripCodeComments`
 * 2. **属性混杂**：判据写成「同一个开标签里 includes(上限) && includes("className") &&
 *    includes("overflow-y-auto")」，三个条件可以分别来自三个属性——
 *    `data-clamp="max-h-[240px]" className="... overflow-y-auto"` 就能骗过去，而真实限高已经丢了。
 *    → `classNameValue` 只取 `className` 属性自身的值
 */

/** 剥掉块注释与行注释（JSX 的 `{/* ... *\/}` 会被块注释规则吃掉）。 */
export const stripCodeComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 取一个 JSX 开标签里 `className` 属性自身的值，取不到返回 null。
 *
 * 支持的五种写法：`className="..."`、`className='...'`、``className={`...`}``、
 * `className={"..."}`、`className={'...'}`。模板串里的 `${...}` 原样保留在返回值里
 * （本仓库的限高 class 都写在模板串的字面量部分）。
 */
export function classNameValue(tag) {
	const match = tag.match(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/);
	if (!match) return null;
	return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? null;
}

/**
 * 扫出一个源码里所有元素开标签（含 `<ListTag>` 这类标签名是变量的写法）。
 *
 * 为什么不用 `<(?:ul|div)` 白名单：接入点为了在虚拟化分支换成合法 DOM 会用
 * `const ListTag: "ul" | "div" = ...`，写死标签名会让判据在改标签时静默失配——
 * 而那正是判据最该盯住的时刻。
 *
 * 已知局限：`[^>]*` 会在 `=>`（箭头函数属性）的 `>` 处提前结束，所以带内联箭头函数的
 * 标签只能扫到箭头之前的属性。用于「找带某个 className 的限高元素」时不受影响
 *（限高元素的 className 都在首个箭头之前）。
 */
export function openingTags(code) {
	return code.match(/<[A-Za-z][\w.$]*\b[^>]*>/g) ?? [];
}

/** 找出 className 里同时含 `needle` 与 `overflow-y-auto` 的那个开标签。 */
export function findCappedListTag(code, needle) {
	return openingTags(code).find((tag) => {
		const className = classNameValue(tag);
		return className !== null && className.includes(needle) && className.includes("overflow-y-auto");
	});
}
