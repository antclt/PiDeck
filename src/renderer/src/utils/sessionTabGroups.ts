/**
 * 会话 Tab 栏「按项目分组 + 分屏组折叠」纯逻辑（浏览器标签组风格）。
 *
 * 不变量：
 * - 分组只作用于普通 Tab；固定（pinned）Tab 保持平铺在最前，分组不拆固定区；
 * - 组顺序 = 该组第一个 Tab 在 tabs 中的出现顺序；组内按 tabs 原序 ——
 *   「新打开的会话追加到它所属项目分组的末尾」由这个顺序语义天然保证，
 *   不需要改动 tabs 数组本身；
 * - 无项目归属（projectId 缺失 / 项目已删除）的会话不包组，平铺在组后。
 *
 * 颜色：按 projectId 稳定哈希取色（同一项目恒同色），色值与分屏组色板同源，
 * 见 SPLIT_GROUP_COLOR_PALETTE（SessionTabsBar 引用本常量构建）。
 *
 * ⚠️ 显示顺序的唯一来源是 buildSessionTabBarEntries：渲染（SessionTabsBar）与
 * Ctrl+Tab 循环切换（useSessionWorkspaceChrome）都必须消费它。底层 tabs 数组是
 * 「打开顺序」，多项目混排/分屏折叠后与显示顺序不同（issue #346 的真因），
 * 直接拿 tabs 算循环目标会跳到屏幕上不相邻的 Tab。
 */

import { moveKeyRelative, sameOrder } from "./listReorder";

/** 分组色板（浏览器标签组风格 8 色；分屏组与项目分组共用，保证视觉一致）。 */
export const GROUP_COLOR_VALUES = [
	"#0091ff", // blue（默认色，与 SPLIT_GROUP_DEFAULT_COLOR 一致）
	"#30a46c", // green
	"#f5d90a", // yellow
	"#f76b15", // orange
	"#e5484d", // red
	"#8e4ec6", // purple
	"#d6409f", // pink
	"#8d8d8d", // gray
] as const;

export type SessionProjectRef = {
	projectId: string;
	/** 项目显示名（空则回退 projectId） */
	name?: string;
};

export type ProjectTabGroup = {
	projectId: string;
	name: string;
	color: string;
	sessionIds: string[];
};

/**
 * projectId → 稳定色：FNV-1a 风格 31 倍哈希取模色板。
 * 纯展示用，同一 id 永远同色；不同 id 碰撞不影响正确性（只是同色）。
 */
export function projectGroupColor(projectId: string): string {
	let hash = 0;
	for (let i = 0; i < projectId.length; i += 1) {
		hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
	}
	return GROUP_COLOR_VALUES[Math.abs(hash) % GROUP_COLOR_VALUES.length];
}

/** 构建项目分组视图（分组开关开启时 Tab 栏的整体布局数据）。 */
export function buildProjectTabGroups(tabs: readonly string[], pinned: readonly string[], projectOf: (sessionId: string) => SessionProjectRef | undefined): { pinned: string[]; groups: ProjectTabGroup[]; loose: string[] } {
	const pinnedOut: string[] = [];
	const loose: string[] = [];
	const groupsByProject = new Map<string, ProjectTabGroup>();
	for (const sessionId of tabs) {
		// 固定 Tab 平铺前置，不参与分组（与「固定 Tab 前置、无关闭按钮」语义一致）。
		if (pinned.includes(sessionId)) {
			pinnedOut.push(sessionId);
			continue;
		}
		const ref = projectOf(sessionId);
		if (!ref || !ref.projectId) {
			// 会话未关联项目（如纯聊天、目录已删除）：不包组，平铺展示。
			loose.push(sessionId);
			continue;
		}
		let group = groupsByProject.get(ref.projectId);
		if (!group) {
			group = {
				projectId: ref.projectId,
				name: ref.name?.trim() || ref.projectId,
				color: projectGroupColor(ref.projectId),
				sessionIds: [],
			};
			groupsByProject.set(ref.projectId, group);
		}
		group.sessionIds.push(sessionId);
	}
	return { pinned: pinnedOut, groups: [...groupsByProject.values()], loose };
}

/**
 * 标签栏「显示单元」：一个渲染节点 + 它在显示顺序里占用的会话序列。
 * - tab：自由 Tab（固定 Tab / 无项目归属）；
 * - project：项目分组，整组连续输出（组内按 tabs 原序，新打开的回到组尾）；
 * - split：分屏组，整组折叠成一个「组头胶囊 + 组内 Tab」节点（组内按分屏 layout 视觉顺序）。
 */
export type SessionTabBarEntry = { kind: "tab"; sessionId: string } | { kind: "project"; projectId: string; sessionIds: string[] } | { kind: "split"; sessionIds: string[] };

/**
 * 构建标签栏显示单元序列 —— 渲染顺序与 Ctrl+Tab 循环顺序的唯一定义。
 *
 * 顺序语义（与旧渲染期合并逻辑逐字对齐，仅把「显示顺序」从渲染层提到共享纯函数）：
 * - 按 tabs（打开顺序）扫描；
 * - 分屏组成员不参与项目分组，其单元落在「layout 首个仍在 tabs 的成员」所在的槽位
 *  （锚点缺失时回退到首个在场成员，避免 layout 与 tabs 短暂不一致导致整组消失）；
 * - 项目分组在该组首个未消费成员处整组输出；
 * - 每个 tab 恰好出现一次（pinned / 分组 / loose 全覆盖）。
 */
export function buildSessionTabBarEntries(tabs: readonly string[], pinned: readonly string[], splitGroupIds: readonly string[], projectOf: (sessionId: string) => SessionProjectRef | undefined): SessionTabBarEntry[] {
	// 只统计确实还在 tabs 里的分屏成员：成员数不足 2 时分屏组不成立，按普通 Tab 参与项目分组。
	const splitMembers = splitGroupIds.filter((id) => tabs.includes(id));
	const hasSplit = splitMembers.length > 1;
	const splitSet = new Set(hasSplit ? splitMembers : []);
	const splitAnchor = hasSplit ? splitMembers[0] : undefined;
	// 分屏组内的 Tab 不参与项目分组（保持分屏语义），与渲染层的既有行为一致。
	const projectView = buildProjectTabGroups(hasSplit ? tabs.filter((id) => !splitSet.has(id)) : tabs, pinned, projectOf);
	const groupBySession = new Map<string, ProjectTabGroup>();
	for (const group of projectView.groups) {
		for (const id of group.sessionIds) groupBySession.set(id, group);
	}

	const entries: SessionTabBarEntry[] = [];
	const emitted = new Set<string>();
	for (const sessionId of tabs) {
		if (emitted.has(sessionId)) continue;
		if (hasSplit && splitSet.has(sessionId)) {
			// 锚点之前的成员先跳过，到锚点处整组一次输出（组内保持 layout 视觉顺序）。
			if (sessionId !== splitAnchor) continue;
			for (const id of splitMembers) emitted.add(id);
			entries.push({ kind: "split", sessionIds: [...splitMembers] });
			continue;
		}
		const group = groupBySession.get(sessionId);
		if (group) {
			const sessionIds = group.sessionIds.filter((id) => !emitted.has(id));
			for (const id of sessionIds) emitted.add(id);
			entries.push({ kind: "project", projectId: group.projectId, sessionIds });
			continue;
		}
		entries.push({ kind: "tab", sessionId });
		emitted.add(sessionId);
	}
	return entries;
}

/**
 * 折叠为「显示顺序」的会话 id 序列：与 SessionTabsBar 的渲染顺序逐项相同，
 * 供 Ctrl+Tab 循环切换取目标（分屏组从胶囊位置起按组内顺序展开）。
 */
export function flattenSessionTabBarEntries(entries: readonly SessionTabBarEntry[]): string[] {
	const order: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "tab") order.push(entry.sessionId);
		else order.push(...entry.sessionIds);
	}
	return order;
}

/**
 * 拖拽排序（显示顺序口径）：把 sourceId 挪到 targetId 的前/后。
 *
 * 为什么不能直接改底层 `tabs`：画面顺序由 buildSessionTabBarEntries 按「项目分组 +
 * 分屏折叠」重排，写 `tabs` 的顺序和屏幕顺序不是一回事 —— 单项目里拖到末尾、跨项目
 * 插队都可能「内部数组变了、画面没动」，甚至内部顺序被静默改坏（issue #453 根因二）。
 * 这里反过来做：先在**显示顺序**上完成移动，再把结果写回一个「分组后仍等于该顺序」的
 * tabs 数组，最后用同一套分组函数复算校验。
 *
 * 移动语义（与渲染层的落点几何 sessionTabDrag 对齐）：
 * - 组内移动：锚点是组内某个 Tab，插到它前/后；
 * - 跨组移动：分组要求同项目会话相邻，**整块**挪到目标块的对应外缘 —— 单个 Tab
 *   插进别的项目分组中间在分组规则下无法显示，硬写就会「画面不动」（#453 的偏移/静默失效）；
 * - 分屏组：组内顺序由分屏布局决定，组员拖动不改写（返回 null），作为落点时吸附到整组外缘；
 * - 固定区沿用 reorderSessionTabs 的语义：拖进固定区即固定、拖出即取消固定（此时按单 Tab 移动）；
 * - 聚拢后显示顺序若与当前完全相同，返回 null —— 调用方什么都不写，而不是
 *   「内部顺序被改坏、画面却没动」。
 *
 * 返回 null 表示「显示顺序没有任何变化」，调用方应跳过 setState / 持久化。
 */
export function reorderSessionTabsByDisplayOrder(tabs: readonly string[], pinned: readonly string[], splitGroupIds: readonly string[], projectOf: (sessionId: string) => SessionProjectRef | undefined, sourceId: string, targetId: string, position: "before" | "after"): { tabs: string[]; pinned: string[] } | null {
	if (sourceId === targetId) return null;
	const display = flattenSessionTabBarEntries(buildSessionTabBarEntries(tabs, pinned, splitGroupIds, projectOf));
	if (!display.includes(sourceId) || !display.includes(targetId)) return null;
	const splitMembers = new Set(splitGroupIds.filter((id) => tabs.includes(id)));
	// 分屏组员：组内顺序由分屏布局给出，拖拽改不动它（拖出分屏要先去分屏，不在本入口）。
	if (splitMembers.has(sourceId)) return null;

	// 某个 Tab 所属的「项目分组块」（固定 Tab / 分屏成员 / 无项目归属都不成块）。
	const blockOf = (sessionId: string): string[] | null => {
		if (pinned.includes(sessionId) || splitMembers.has(sessionId)) return null;
		const projectId = projectOf(sessionId)?.projectId;
		if (!projectId) return null;
		const members = display.filter((id) => !pinned.includes(id) && !splitMembers.has(id) && projectOf(id)?.projectId === projectId);
		return members.length > 1 ? members : null;
	};

	// 目标落在分屏组内 → 吸附到整组外缘（组内没有可插入的槽位）。
	let anchorId = targetId;
	if (splitMembers.has(targetId)) {
		const members = display.filter((id) => splitMembers.has(id));
		if (members.length === 0) return null;
		anchorId = position === "before" ? members[0] : members[members.length - 1];
	}

	// 目标落在别的项目分组内 → 吸附到该组外缘（落点几何画线也在同一位置）。
	const targetBlock = blockOf(anchorId);
	if (targetBlock && !targetBlock.includes(sourceId)) {
		anchorId = position === "before" ? targetBlock[0] : targetBlock[targetBlock.length - 1];
	}

	const sourcePinned = pinned.includes(sourceId);
	const targetPinned = pinned.includes(anchorId);
	const pinnedCrossing = sourcePinned !== targetPinned;
	const nextPinned = pinnedCrossing ? (sourcePinned ? pinned.filter((id) => id !== sourceId) : [...pinned, sourceId]) : [...pinned];

	// 跨块：整块移动（整组挪到锚点前/后）；其余情况单 Tab 移动。
	const sourceBlock = pinnedCrossing ? null : blockOf(sourceId);
	let desired: string[];
	if (sourceBlock && !sourceBlock.includes(anchorId)) {
		const rest = display.filter((id) => !sourceBlock.includes(id));
		const index = rest.indexOf(anchorId);
		const at = index === -1 ? rest.length : index + (position === "after" ? 1 : 0);
		desired = [...rest.slice(0, at), ...sourceBlock, ...rest.slice(at)];
	} else {
		desired = moveKeyRelative(display, sourceId, anchorId, position);
	}

	// 写回底层顺序：固定区在前（不变量），其余按落点顺序。desired 内部相对顺序保持不变。
	const nextTabs = [...desired.filter((id) => nextPinned.includes(id)), ...desired.filter((id) => !nextPinned.includes(id))];
	const nextDisplay = flattenSessionTabBarEntries(buildSessionTabBarEntries(nextTabs, nextPinned, splitGroupIds, projectOf));
	if (sameOrder(nextDisplay, display) && sameOrder(nextPinned, pinned)) return null;
	return { tabs: nextTabs, pinned: nextPinned };
}
