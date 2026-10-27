/**
 * 引用复用的纯函数层（不依赖 React、不依赖具体业务类型）。
 *
 * 为什么单独一个文件、放在 `lib/` 而不是 `components/session/timeline/`：
 * 这一层是纯逻辑（数组逐项比对、引用等价判断），业务侧（`timeline/structureReuse.ts`）的
 * 判据函数依赖它，hook 层（`lib/hooks/use-render-reuse.ts`）也依赖它。放在 components 下
 * 会让「lib 反向 import components」，依赖方向倒挂；放在这里，两边都指向 lib。
 *
 * `timeline/structureReuse.ts` 仍然 re-export 本文件的函数，保持既有调用点与测试路径不变。
 */

/** 逐项相等判据：调用方给出「这两个条目算不算同一个」。 */
export type ItemSame<T> = (previous: T, next: T) => boolean;

/** 引用逐项等价：长度相同且每个下标 `===`。 */
export function sameReferenceList<T>(previous: readonly T[] | undefined, next: readonly T[] | undefined): boolean {
	if (previous === next) return true;
	if (!previous || !next) return false;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) {
		if (previous[index] !== next[index]) return false;
	}
	return true;
}

/**
 * 列表结构复用：内容等价的条目换回上一轮的对象引用。
 *
 * 三件事，缺任何一条都不成立：
 * 1. **长度相同时数组本身也复用**（全命中时直接返回 `previous`）——下游 `useMemo` /
 *    `useEffect` 依赖的往往正是数组引用，只复用条目而复用不了数组等于白做；
 * 2. **长度不同必须换数组**（长度是下游切片与计数的依据，复用会返回错长度的列表）；
 * 3. **逐项比对用调用方给的 `same`**，本层不猜字段——猜错就会静默复用内容已变的条目。
 *
 * 这是「渲染层引用链」的地基：`build*` / `group*` 这类纯函数每次调用都新建对象，
 * 而下游组件的 `memo` 只认引用。把条目换回旧引用，整条链的 memo 才能逐层命中。
 */
export function reuseStructure<T>(previous: readonly T[] | undefined, next: T[], same: ItemSame<T>): T[] {
	if (!previous) return next;
	if (previous.length !== next.length) {
		// 长度变了：数组必须换新，但同下标命中项仍然复用（尾部追加是流式最常见的形态）。
		return next.map((item, index) => {
			const previousItem = previous[index];
			return previousItem !== undefined && same(previousItem, item) ? previousItem : item;
		});
	}
	let allReused = true;
	const merged = next.map((item, index) => {
		const previousItem = previous[index];
		if (previousItem !== undefined && same(previousItem, item)) return previousItem;
		allReused = false;
		return item;
	});
	return allReused ? (previous as T[]) : merged;
}
