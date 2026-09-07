/**
 * 公告通知调度 hook（全局唯一挂载点：App.tsx，与 useAgentLoadNotice 同层）。
 *
 * 设计要点：
 * - 轮询驱动而非事件驱动：公告是低频广播（快照最迟 2h 才可能变化），3s 轮询的
 *   空转成本（2 次 atom 读 + 3 次 DOM 查询）可忽略，却能把「忙碌判定」做成持续
 *   状态检查，避免为 composer 焦点/Agent 事件/弹窗开关各建一条订阅链。
 * - 不打扰原则：composer 输入聚焦、Agent 运行中、模态打开、窗口不活跃四类状态
 *   都不弹；待提醒内容不丢弃（侧栏红点仍在），空闲后下一轮自动补弹。
 *   判定策略在 utils/announcementNotifyPolicy.ts（纯函数，tests 可单测）。
 * - 单条节奏：每轮最多弹 1 条 + 最小间隔，多条未读时依次补弹，不刷屏。
 * - 用户点开公告中心 = 已知悉：本运行周期不再为这些旧公告弹 toast（重启才重置）。
 */
import { useEffect, useRef } from "react";
import { getDefaultStore, useAtomValue } from "jotai";
import {
	announcementCenterOpenAtom,
	announcementNotificationEnabledAtom,
	unreadAnnouncementsAtom,
} from "../atoms/announcement-atoms";
import { currentSessionRuntimeAtom } from "../atoms/session-atoms";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import {
	isBusyForAnnouncement,
	levelToNoticeKind,
	nextTickDelayMs,
	ANNOUNCEMENT_POLL_VISIBLE_MS,
} from "../utils/announcementNotifyPolicy";
import type { AnnouncementBusyContext } from "../utils/announcementNotifyPolicy";

/** 单条 toast 展示时长（ms）：showNotice 的 info 默认 1.5s 太短，公告需要可读时长。 */
const ANNOUNCEMENT_TOAST_DURATION_MS = 6000;
/** 两条公告 toast 的最小间隔（ms）：多条未读时错峰弹出，避免瞬间堆一排。 */
const ANNOUNCEMENT_TOAST_GAP_MS = 4000;

/**
 * 当前聚焦会话的 Agent 是否运行中。与 App.isAgentCurrentlyBusy 同口径
 * （status running / isStreaming / isExecutingTool），读取走默认 jotai store，
 * 不经过 React 订阅——轮询 tick 里按需取最新值即可。
 */
function isCurrentAgentBusy(): boolean {
	const runtime = getDefaultStore().get(currentSessionRuntimeAtom);
	return (
		runtime?.status === "running" ||
		Boolean(runtime?.state?.isStreaming) ||
		Boolean(runtime?.state?.isExecutingTool)
	);
}

/**
 * 采集当前「是否可打扰」上下文。非纯函数（读 DOM / jotai store），
 * 判定逻辑全部在纯策略函数 isBusyForAnnouncement 内，本函数只做采集。
 */
function readAnnouncementBusyContext(): AnnouncementBusyContext {
	return {
		// 焦点在 composer 富文本输入框内（closest 覆盖输入框内的子节点）：正在打字/选词
		composerFocused: document.activeElement?.closest(".rich-input") != null,
		agentBusy: isCurrentAgentBusy(),
		// 任意 Radix 模态对话框打开（portal 渲染在 body 下）：toast 会压在弹窗上层
		modalOpen: document.querySelector('[role="dialog"]') != null,
		// 窗口失焦/最小化/托盘隐藏：用户不在看 PiDeck，不着急弹（hasFocus 在个别老内核可能缺失，防御一下）
		windowInactive:
			typeof document.hasFocus === "function" ? !document.hasFocus() : false,
	};
}

/**
 * 公告通知调度。开关读 announcementNotificationEnabledAtom 镜像（App.tsx 从
 * settings 同步，参数化 prop 改为 atom 后切开关最多延迟一个轮询周期生效，
 * 约 3s，对低频公告无感知）；关闭后完全不弹 toast，入口按钮与红点由
 * AnnouncementCenter 按同一开关隐藏。
 */
export function useAnnouncementNotifier(): void {
	// 本运行周期已弹过 toast 的公告 id：防止同一条公告反复打扰（应用重启才重置）
	const shownIdsRef = useRef<Set<string>>(new Set());
	const lastToastAtRef = useRef(0);
	const centerOpen = useAtomValue(announcementCenterOpenAtom);

	// 用户主动打开公告中心 = 待提醒内容已全部可见：全部标记为已展示，
	// 关闭弹窗后不再为这些旧公告弹 toast（之后新公告照常提醒）。
	useEffect(() => {
		if (!centerOpen) return;
		const unread = getDefaultStore().get(unreadAnnouncementsAtom);
		for (const item of unread) shownIdsRef.current.add(item.id);
	}, [centerOpen]);

	useEffect(() => {
		// 开关走镜像 atom 而非 effect 依赖：轮询链路不重建，切开关最迟下个 tick 生效
		if (!getDefaultStore().get(announcementNotificationEnabledAtom)) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			// 先排下一轮再处理本轮：任何提前 return 的分支都不会打断轮询节奏
			timer = setTimeout(tick, nextTickDelayMs(readAnnouncementBusyContext()));
			const pending = getDefaultStore()
				.get(unreadAnnouncementsAtom)
				.filter((item) => !shownIdsRef.current.has(item.id));
			// 无待提醒 / 距上一条 toast 不足间隔（多条未读错峰）→ 本轮跳过
			if (pending.length === 0) return;
			if (Date.now() - lastToastAtRef.current < ANNOUNCEMENT_TOAST_GAP_MS) return;
			// 不打扰判定：忙碌时本轮跳过，待提醒集合不丢（红点仍在），空闲后自动补弹
			if (isBusyForAnnouncement(readAnnouncementBusyContext())) return;
			const item = pending[0];
			shownIdsRef.current.add(item.id);
			lastToastAtRef.current = Date.now();
			// 正文纯文本展示（与公告中心一致，不做 markdown 渲染，控制攻击面）；
			// 「查看」按钮打开公告中心（atom 驱动，见 announcement-atoms）。
			showNotice(
				item.body,
				ANNOUNCEMENT_TOAST_DURATION_MS,
				levelToNoticeKind(item.level),
				item.title,
				{
					action: {
						label: t("announcements.toast.view"),
						onClick: () => getDefaultStore().set(announcementCenterOpenAtom, true),
					},
				},
			);
		};
		timer = setTimeout(tick, ANNOUNCEMENT_POLL_VISIBLE_MS);
		return () => {
			if (timer !== undefined) clearTimeout(timer);
		};
	}, []);
}
