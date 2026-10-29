import type { TurnProcessNode } from "./groupTurnProcess";

/**
 * 基础引用工具由 `lib/renderReuse.ts` 提供（纯函数层，不依赖 React 与业务类型）。
 * 这里 re-export 是为了让业务判据与其配合使用时只有一个 import 来源，
 * 同时保持既有调用点与测试路径不变。
 */
export { reuseStructure, sameReferenceList, type ItemSame } from "../../../lib/renderReuse";
import { sameReferenceList } from "../../../lib/renderReuse";
import type { TurnDisplayItem, TurnProcessEntry } from "./types";

/**
 * 结构复用：当「新一轮计算」产出的条目与上一轮内容相同时，把旧对象引用换回去。
 *
 * 为什么需要（2026-10 性能治理）：时间线上游每一层都在每次 50ms flush 时**新建**输出对象——
 * `groupToolMessages` 新建 tool-group / thinking-group，`buildTurnDisplay` 新建 entry 包装，
 * `groupTurnProcess` 新建过程组节点。即使成员消息的引用逐项相同（`session-atoms` 的增量合并
 * 用 `[...current.messages.slice(0, offset), ...increment]` 保留了未变消息的对象），这些中间
 * 对象还是全新的，于是下游所有 `memo` 与 `useMemo` 按引用比较**全部失效**：
 * `ProcessFold` 重渲染 → `ProcessGroupStep` 重渲染 → 已展开的组每次都重建预算内（120 条）的成员
 * 元素与组头文案。虚拟化裁掉的是 DOM，裁不掉这条「引用全换」的重建链。
 *
 * 契约（三件事，测试钉住）：
 * - 逐项判定用调用方给的 `same`（必须只比内容，不比引用：引用相等时会先被 `===` 短路）；
 * - **全部命中且长度相同才返回 `previous` 数组本身**——只是逐项复用但长度变了时必须返回新数组，
 *   否则下游拿到长度不对的数组会静默丢条目；
 * - 长度相同但中间有项不命中时返回新数组，其中命中项已换回旧引用（局部复用，仍然省下这些子树）。
 *
 * 纯函数、零依赖（node 单测直接加载）。
 */

/** 两个数组是否逐项引用相同（长度相等且每项 `===`）。过程组的成员列表用它判「内容没变」。 */

/* ── 时间线各层的同一性判据 ──
 *
 * 这些判据只回答「内容是否没变」，全部按引用比较：上游 `reconcileRuns` 已经保证未变的条目
 * 引用稳定（含 run.items 的条目级复用），所以引用相等就是内容相等，不需要深比较。
 *
 * 为什么必须成套存在：`buildTurnDisplay` 每次新建 entry 包装、`groupTurnProcess` 每次新建过程组
 * 节点，即使成员引用完全没变。缺任何一层，下游 `memo` 就按新引用判为变化，链路从那一层断开。
 */

/** 过程条目同一性：kind + id + 内部引用。 */
export function sameTurnProcessEntry(a: TurnProcessEntry, b: TurnProcessEntry): boolean {
	if (a === b) return true;
	if (a.kind !== b.kind || a.id !== b.id) return false;
	switch (b.kind) {
		case "thinking-entry":
			return a.kind === "thinking-entry" && a.group === b.group;
		case "tool-entry":
			return a.kind === "tool-entry" && a.group === b.group;
		case "retry-entry":
		case "error-entry":
			return a.kind === b.kind && a.message === b.message;
		case "extension-entry":
			return a.kind === "extension-entry" && a.messages === b.messages;
	}
}

/** 扁平展示项同一性：process-entry 比 entry，interim/final 比 message。 */
export function sameTurnDisplayItem(a: TurnDisplayItem, b: TurnDisplayItem): boolean {
	if (a === b) return true;
	if (a.kind !== b.kind) return false;
	if (a.kind === "process-entry" && b.kind === "process-entry") return sameTurnProcessEntry(a.entry, b.entry);
	if (a.kind === "interim-answer" && b.kind === "interim-answer") return a.id === b.id && a.message === b.message;
	if (a.kind === "final-answer" && b.kind === "final-answer") return a.id === b.id && a.message === b.message;
	return false;
}

/**
 * 过程组节点同一性：组成员逐项引用相同、中间回复消息同一、一级行条目同一。
 *
 * 组头的 `counts` / `toolCount` / `hasThinking` / `extensionCount` 全部由 members 推导，
 * 所以 members 相同即这些字段相同，不必逐个比。
 */
export function sameTurnProcessNode(a: TurnProcessNode, b: TurnProcessNode): boolean {
	if (a === b) return true;
	if (a.kind !== b.kind || a.id !== b.id) return false;
	if (a.kind === "group" && b.kind === "group") return sameReferenceList(a.members, b.members);
	if (a.kind === "interim" && b.kind === "interim") return a.message === b.message;
	if (a.kind === "entry" && b.kind === "entry") return a.entry === b.entry;
	return false;
}
