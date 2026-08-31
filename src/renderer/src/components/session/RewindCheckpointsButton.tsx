import { useState } from "react";
import { History } from "lucide-react";
import { t } from "../../i18n";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { ScrollArea } from "../ui-shadcn/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { RewindCheckpointList } from "./RewindCheckpointList";
import type { AgentBackend } from "../../../../shared/types";

/**
 * 检查点（rewind）入口按钮：底栏压缩圆环旁常驻。
 *
 * 能力边界：只有声明 rewind 能力的后端才渲染入口。渲染层目前没有
 * per-backend capability 枚举，先用 backend==="pi" 近似门控（pi 声明能力，
 * dsh/imagegen 不声明）；将来后端能力下沉到 runtime state 后应改为按能力列表判断。
 *
 * 弹层与右侧抽屉面板（RewindPanel）共用 RewindCheckpointList：展示当前会话在
 * refs/pi-checkpoints 下的快照，支持查看 diff、按范围回退文件/会话。
 */
export function RewindCheckpointsButton(props: {
	sessionId: string;
	backend?: AgentBackend;
	disabled?: boolean;
}) {
	// 仅 pi 后端声明 rewind 能力；其他后端不渲染入口（hooks 留在内层组件里）。
	const supported = props.backend === undefined || props.backend === "pi";
	if (!supported) return null;
	return <RewindCheckpointsButtonInner sessionId={props.sessionId} disabled={props.disabled} />;
}

function RewindCheckpointsButtonInner(props: { sessionId: string; disabled?: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							disabled={props.disabled}
							className="grid size-7 flex-none place-items-center rounded-full text-text-tertiary transition-colors hover:bg-muted/60 disabled:cursor-default disabled:opacity-50"
							aria-label={t("rewind.title")}
							aria-haspopup="dialog"
							aria-expanded={open}
						>
							<History size={14} strokeWidth={1.8} aria-hidden="true" />
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("rewind.openTitle")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="end"
				className="w-[340px] p-2"
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<div className="flex items-center gap-1.5 px-1 pb-1.5 text-xs font-semibold text-foreground">
					<History size={13} strokeWidth={1.8} aria-hidden="true" />
					{t("rewind.title")}
				</div>
				{/* 挂载即拉取 = 每次打开弹层都刷新（回退后列表会变化，ref 也可能被外部 pi 进程新增）。 */}
				<ScrollArea className="max-h-[300px]">
					{/* pb-1：给滚动视口留底部余量，避免最后一张卡片/「显示全部」按钮被边界从中间裁断。 */}
					<div className="space-y-1.5 pb-1 pr-2">
						<RewindCheckpointList sessionId={props.sessionId} />
					</div>
				</ScrollArea>
			</PopoverContent>
		</Popover>
	);
}
