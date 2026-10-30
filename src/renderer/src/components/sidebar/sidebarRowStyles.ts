/**
 * 侧栏资源行共享样式基座（Wave 3 §2：项目/Agent/会话行复用同一行模式）。
 *
 * 背景：SessionTree / ActiveSessionsTree / RecentSessionsSection 此前各自维护
 * 一份逐字相同的行 class（`tests/sidebarActivityRecent.test.mjs` 曾用逐字一致性
 * 断言锁住三份拷贝的同步——那正是该抽共享常量的信号）。
 *
 * 收敛范围：只有「真正逐字相同」的部分。领域差异（项目行 pr-[88px] 三按钮、
 * worktree 行 pr-[52px]、草稿行删除格、SessionGroupsSection 低密度只读行）
 * 仍留在各文件——强行合并会让 props 面比差异本身还大。
 *
 * 消费方式：各文件从本地 const 改为 re-export 本文件常量，class 字符串不变，
 * CSS 层（foundation.css .conversation-body/.session-row 等）零改动。
 */

/** 会话/Agent 行样式基座：min-h-8 圆角行 + hover/选中/焦点环。
 *  与 ProjectTree.treeRowClass 同尺寸同圆角（见 SessionTree 头注释）。 */
export const SESSION_ROW_CLASS =
	"group/resource conversation agent-row relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-base hover:border-border-subtle hover:bg-bg-hover hover:text-foreground focus-visible:bg-bg-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 叶子选中态：灰底、无描边（小步长选中感，见 SessionTree 注释）。 */
export const SESSION_ROW_SELECTED_CLASS = "active bg-bg-active text-foreground";

/** 行右侧「⋯」按钮浮层：absolute 不占布局，行 hover/行内聚焦时显现；
 *  标题用 conversation-body 上的 pr-7 让位（一个按钮宽），见 SessionTree 注释。 */
export const ROW_MORE_ACTIONS_CLASS =
	"row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";

/** 行容器：内容行占满 + 按钮浮层（button 不能嵌 button，且浮层不占位）。 */
export const ROW_CONTAINER_CLASS = "group/row relative mt-0.5 flex min-h-8 items-center";
