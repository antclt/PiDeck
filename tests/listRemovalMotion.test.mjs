import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 列表删除动画契约（2026-10 motion 体验优化，第二批位移线扩展）。
 *
 * 背景：智能体市场与收藏列表的重排已有 FLIP 落位（useListReorder），但**删除**
 * （单删确认 / 批量删除）是瞬时消失——卡片原地蒸发，兄弟条目瞬移补位。
 * 侧栏早有同一场景的原语（SidebarRemovalRow：AnimatePresence popLayout + 淡出 +
 * layout="position" 位移收拢，搜索隐藏 ≠ 删除、reduced-motion 归零），
 * 本批把它提炼为共享模块 components/removal/RemovalList 并接入两个列表。
 *
 * 与 useListReorder 的分工（防止双重动画）：重排不 bump 生成数——拖拽落位动画
 * 仍由 useListReorder 的手动 FLIP 独占；RemovalRow 只在真实删除时淡出 + 滑位。
 *
 * 正则一律空白容忍（\s*），格式化不应打红本契约。
 */

const read = (path) => readFileSync(`src/renderer/src/${path}`, "utf8");

test("RemovalList 是共享原语：侧栏薄包装零行为变化", () => {
	const primitive = read("components/removal/RemovalList.tsx");
	assert.match(primitive, /export function RemovalList/, "共享模块必须导出 RemovalList");
	assert.match(primitive, /export const RemovalRow = forwardRef/, "共享模块必须导出 RemovalRow");
	assert.match(primitive, /mode="popLayout"/, "popLayout：退出行一次性移出文档流，不逐帧压高度");
	assert.match(primitive, /layout="position"/, "存活行按位移收拢，不改自身尺寸");
	// 侧栏旧导入路径保留为薄包装：不许在包装里复活实现（会出现两份漂移的实现）
	const wrapper = read("components/sidebar/SidebarRemovalRow.tsx");
	assert.match(wrapper, /export \{ RemovalList as SidebarRemovalList, RemovalRow as SidebarRemovalRow \} from "\.\.\/removal\/RemovalList"/, "侧栏只做 re-export");
	assert.doesNotMatch(wrapper, /motion\/react/, "包装层不得自带实现");
});

test("智能体市场网格：删除淡出 + 网格位移收拢", () => {
	const source = read("components/agents/market/AgentMarketGrid.tsx");
	assert.match(source, /import \{ RemovalList, RemovalRow \} from "\.\.\/\.\.\/removal\/RemovalList"/);
	// remainingIds 必须用未过滤的 orderIds：搜索/分类隐藏 ≠ 删除（exit 时长 0）
	assert.match(source, /<RemovalList\s+remainingIds=\{orderIds\}>/, "remainingIds 必须来自未过滤的完整顺序");
	assert.match(source, /<RemovalRow\s+key=\{agent\.id\}\s+itemId=\{agent\.id\}>/, "卡片必须逐个包在 RemovalRow 里（key 上移到包装层）");
});

test("收藏列表：删除淡出 + 列表位移收拢", () => {
	const source = read("components/favorites/FavoritesWorkspace.tsx");
	assert.match(source, /import \{ RemovalList, RemovalRow \} from "\.\.\/removal\/RemovalList"/);
	// remainingIds 必须用未过滤的 allIds：搜索/筛选隐藏 ≠ 删除
	assert.match(source, /<RemovalList\s+remainingIds=\{allIds\}>/, "remainingIds 必须来自未过滤的完整顺序");
	assert.match(source, /<RemovalRow\s+key=\{entry\.id\}\s+itemId=\{entry\.id\}>/, "卡片必须逐个包在 RemovalRow 里（key 上移到包装层）");
});
