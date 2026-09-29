import { useCallback, useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { ApprovalCard } from "../ui-shadcn/approval-card";

// Minimum viable i18n: the project has full key-based i18n, but CUA is a new
// feature and we don't want to block on zh-CN/en-US key additions right now.
// Use inline labels that will be migrated to translation keys in a follow-up.
const LABELS = {
	title: "CUA 操作审批",
	waiting: "等待审批",
	actionLabel: "操作",
	sessionLabel: "会话",
	detailLabel: "详情",
	allow: "允许",
	deny: "拒绝",
	allowHint: "允许此次操作",
	denyHint: "拒绝此次操作",
	close: "关闭",
} as const;

const ACTION_LABELS: Record<string, string> = {
	click: "鼠标点击",
	type: "键盘输入",
	scroll: "滚动",
	capture: "屏幕截图",
	list_windows: "窗口列表",
	get_state: "状态查询",
};

export type CuaApprovalPayload = {
	requestId: string;
	action: string;
	sessionId: string;
	detail: unknown;
	timestampMs: number;
};

export function CuaApprovalDialog(props: { request: CuaApprovalPayload | null; responding: boolean; open: boolean; onOpenChange: (open: boolean) => void; onRespond: (allowed: boolean) => void; onCancel: () => void }) {
	const { request } = props;

	const formatDetail = useCallback((detail: unknown): string => {
		if (detail == null) return "";
		if (typeof detail === "string") return detail;
		try {
			return JSON.stringify(detail, null, 2);
		} catch {
			return String(detail);
		}
	}, []);

	if (!request) return null;

	const actionLabel = ACTION_LABELS[request.action] ?? request.action;
	const isReadonly = request.action === "capture" || request.action === "list_windows" || request.action === "get_state";

	// Read-only actions should never trigger approval, but if they do, auto-allow.
	if (isReadonly) {
		return null;
	}

	return (
		<ApprovalCard open={props.open} onOpenChange={props.onOpenChange} title={LABELS.title} description={`${actionLabel} · ${LABELS.waiting}`} status={LABELS.waiting} statusTone="active" onCancel={props.onCancel} cancelDisabled={props.responding} cancelLabel={LABELS.close} className="w-full">
			<div className="flex flex-col gap-2">
				{/* 操作类型徽标 */}
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
						<MousePointer2 size={12} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
						<span className="shrink-0">{LABELS.actionLabel}</span>
						<span className="font-semibold text-text-primary">{actionLabel}</span>
					</span>
					<span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-muted px-2 py-0.5 text-micro font-medium text-text-secondary">
						<span className="shrink-0">{LABELS.sessionLabel}</span>
						<span className="font-mono text-text-primary">{request.sessionId.slice(0, 8)}</span>
					</span>
				</div>

				{/* 详情区 */}
				<div className="rounded-md border border-border-subtle bg-bg-muted px-2.5 py-2">
					<div className="mb-1 text-micro font-semibold text-text-tertiary">{LABELS.detailLabel}</div>
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-text-primary">{formatDetail(request.detail)}</pre>
				</div>

				{/* 允许/拒绝 */}
				<div className="flex gap-2">
					<Button variant="default" className="h-8 px-3" disabled={props.responding} title={LABELS.allowHint} onClick={() => props.onRespond(true)}>
						{LABELS.allow}
					</Button>
					<Button variant="outline" className="h-8 px-3" disabled={props.responding} title={LABELS.denyHint} onClick={() => props.onRespond(false)}>
						{LABELS.deny}
					</Button>
				</div>
			</div>
		</ApprovalCard>
	);
}

/**
 * Hook that subscribes to CUA approval requests from the main process
 * and manages the dialog state.
 */
export function useCuaApproval() {
	const [pendingRequest, setPendingRequest] = useState<CuaApprovalPayload | null>(null);
	const [responding, setResponding] = useState(false);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const unsubscribe = window.piDesktop.cua.onApprovalRequest((payload: CuaApprovalPayload) => {
			setPendingRequest(payload);
			setOpen(true);
		});
		return unsubscribe;
	}, []);

	const respond = useCallback(
		async (allowed: boolean) => {
			if (!pendingRequest) return;
			setResponding(true);
			try {
				await window.piDesktop.cua.sendApprovalResponse(pendingRequest.requestId, {
					allowed,
					reason: allowed ? undefined : "user_denied",
				});
			} finally {
				setResponding(false);
				setOpen(false);
				setPendingRequest(null);
			}
		},
		[pendingRequest],
	);

	const cancel = useCallback(() => {
		if (pendingRequest) {
			void window.piDesktop.cua.sendApprovalResponse(pendingRequest.requestId, {
				allowed: false,
				reason: "cancelled",
			});
		}
		setOpen(false);
		setPendingRequest(null);
	}, [pendingRequest]);

	return {
		request: pendingRequest,
		responding,
		open,
		setOpen,
		respond,
		cancel,
	};
}
