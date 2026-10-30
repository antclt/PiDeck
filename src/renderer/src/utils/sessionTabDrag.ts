/**
 * 会话 Tab 拖拽落点几何（纯函数，可单测）。
 *
 * 为什么单独抽出来：HTML5 拖放只给「指针下方元素」派发 drop，旧实现把 dragover/drop
 * 绑在 Tab 自身，Tab 之间的 gap、末尾空白、「+」按钮全是放置死区 —— 指示线画在正确
 * 位置、松手却落在无处理器的元素上（issue #453 根因一）。落点判定必须改到容器级：
 * 容器统一接事件，按**屏幕上看到的矩形**解析落点，缝隙/留白退化为「最近的那个单元」。
 *
 * 落点单元 = 屏幕上**可以独立移动的块**：
 * - 固定 Tab / 无项目归属的会话是单个 `tab`；
 * - 项目分组 / 分屏组是一个 `block`（分组要求同项目会话相邻，外部 Tab 插不进组内）。
 * 因此「拖到另一个项目分组上」落的是**整块的位置**（组会整体挪过去），而不是把单个
 * Tab 塞进组中间 —— 后者在分组规则下根本无法显示，正是 #453 「指示线与结果不一致」的来源。
 *
 * 与 `utils/listReorder.ts` 的分工：那边是通用列表（竖向/网格、任意位置可插）；这里
 * 是横向单轴（Tab 条只有一行，指针在容器任意高度都算数）+ 分组块语义。
 */

import type { SessionTabBarEntry } from "./sessionTabGroups";

export type SessionTabDropPosition = "before" | "after";

/** 分组内某个成员 Tab 的水平区间。 */
export type SessionTabDropMember = { sessionId: string; left: number; width: number };

/** 可落点单元：单个 Tab，或整块一个落点的分组。 */
export type SessionTabDropUnit = { kind: "tab"; sessionId: string; left: number; width: number } | { kind: "block"; blockKind: "project" | "split"; sessionIds: readonly string[]; left: number; width: number; members: SessionTabDropMember[] };

/** 落点：插到哪个会话 Tab 的前/后（分组落点取组边界那一个成员）。 */
export type SessionTabDropTarget = { targetId: string; position: SessionTabDropPosition };

/**
 * 显示单元 → 落点单元序列（顺序即显示顺序）。
 *
 * 宽度为 0 的成员直接丢弃：分屏组收起时组内 Tab 不渲染、Tab 被隐藏时矩形会塌在
 * (0,0)，参与计算会把容器左上角的落点错误吸走。整组都没渲染的分组整块不可放置。
 */
export function buildSessionTabDropUnits(entries: readonly SessionTabBarEntry[], rectOf: (sessionId: string) => { left: number; width: number } | null): SessionTabDropUnit[] {
	const units: SessionTabDropUnit[] = [];
	for (const entry of entries) {
		if (entry.kind === "split") {
			const members: SessionTabDropMember[] = [];
			for (const sessionId of entry.sessionIds) {
				const rect = rectOf(sessionId);
				if (rect && rect.width > 0) members.push({ sessionId, left: rect.left, width: rect.width });
			}
			if (members.length === 0) continue;
			units.push(blockUnit("split", entry.sessionIds, members));
			continue;
		}
		if (entry.kind === "project") {
			const members: SessionTabDropMember[] = [];
			for (const sessionId of entry.sessionIds) {
				const rect = rectOf(sessionId);
				if (rect && rect.width > 0) members.push({ sessionId, left: rect.left, width: rect.width });
			}
			if (members.length === 0) continue;
			units.push(blockUnit("project", entry.sessionIds, members));
			continue;
		}
		const rect = rectOf(entry.sessionId);
		if (!rect || rect.width <= 0) continue;
		units.push({ kind: "tab", sessionId: entry.sessionId, left: rect.left, width: rect.width });
	}
	return units;
}

function blockUnit(blockKind: "project" | "split", sessionIds: readonly string[], members: SessionTabDropMember[]): SessionTabDropUnit {
	const left = Math.min(...members.map((member) => member.left));
	const right = Math.max(...members.map((member) => member.left + member.width));
	return { kind: "block", blockKind, sessionIds, left, width: right - left, members };
}

/**
 * 指针 x → 落点（插到哪个 Tab 的前/后）。
 *
 * 1. 命中单个 Tab：按其中点判前后（单轴，不看 y —— 双轴会让指针上下微动就翻面）。
 * 2. 命中的分组正是拖拽源所在的分组：组内按成员判定，可插到任意两个成员之间。
 * 3. 命中别的分组（或源不在任何分组里）：落在**整组边界** —— 分组要求同项目会话相邻，
 *    组内没有可插入的槽位。指针在组左半 → 组前，右半 → 组后。
 * 4. 指针落在缝隙/末尾空白/「+」按钮上：退到「水平中心最近」的单元再按同一规则判定。
 *    相邻两 Tab 的 gap 两侧指向同一个槽位，末尾留白恒为最后一块的尾部。
 * 5. 分屏组员不可拖拽重组（组内顺序由分屏布局决定），返回 null。
 */
export function resolveSessionTabDropTarget(units: readonly SessionTabDropUnit[], pointerX: number, sourceId: string): SessionTabDropTarget | null {
	const candidates = units.filter((unit) => unit.width > 0);
	if (candidates.length === 0) return null;
	let hit = candidates.find((unit) => pointerX >= unit.left && pointerX <= unit.left + unit.width);
	if (!hit) {
		let nearest = candidates[0];
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const unit of candidates) {
			const distance = Math.abs(pointerX - (unit.left + unit.width / 2));
			if (distance < nearestDistance) {
				nearest = unit;
				nearestDistance = distance;
			}
		}
		hit = nearest;
	}
	if (hit.kind === "tab") return memberTarget(hit, pointerX);
	if (hit.sessionIds.includes(sourceId)) {
		// 同组内：可以插到任意两位成员之间；分屏组内顺序由布局决定，不可拖。
		if (hit.blockKind === "split") return null;
		const member = hit.members.find((item) => pointerX >= item.left && pointerX <= item.left + item.width) ?? nearestMember(hit.members, pointerX);
		return member ? memberTarget(member, pointerX) : null;
	}
	// 其它分组：落在整块边界（组内插不进去）。
	const after = pointerX >= hit.left + hit.width / 2;
	const sessionIds = hit.sessionIds;
	if (sessionIds.length === 0) return null;
	return after ? { targetId: sessionIds[sessionIds.length - 1], position: "after" } : { targetId: sessionIds[0], position: "before" };
}

function memberTarget(member: { sessionId: string; left: number; width: number }, pointerX: number): SessionTabDropTarget {
	return { targetId: member.sessionId, position: pointerX >= member.left + member.width / 2 ? "after" : "before" };
}

function nearestMember(members: readonly SessionTabDropMember[], pointerX: number): SessionTabDropMember | null {
	let nearest: SessionTabDropMember | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const member of members) {
		const distance = Math.abs(pointerX - (member.left + member.width / 2));
		if (distance < nearestDistance) {
			nearest = member;
			nearestDistance = distance;
		}
	}
	return nearest;
}
