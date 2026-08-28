import { ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";

/**
 * 新建会话 split 按钮：主点击默认新建普通会话（保留记录），右侧小箭头下拉可选匿名会话。
 *
 * 业务规则：
 * - 「默认新建普通会话」= 直接点 Plus 就走 createDraft，不做二次选择；
 * - 匿名会话（createAnonymous）不保存记录，藏在折叠项里，避免误点后丢会话；
 * - 用于 Chat 区、项目行、worktree 行三处，尺寸/样式由调用方传入，保持各上下文视觉一致。
 */
export function NewSessionMenu(props: {
  projectId: string;
  actions: SidebarActions;
  /** 主按钮图标尺寸（默认 14） */
  size?: number;
  /** 主按钮（Plus）样式类；缺省为侧栏小图标按钮样式 */
  buttonClassName?: string;
  /** 下拉箭头样式类；缺省为侧栏小图标按钮样式 */
  chevronClassName?: string;
}) {
  const { projectId, actions } = props;
  const size = props.size ?? 14;
  const buttonClassName =
    props.buttonClassName ??
    "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
  const chevronClassName =
    props.chevronClassName ??
    "grid size-3.5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
  return (
    <div className="flex items-center">
      <button
        type="button"
        className={buttonClassName}
        title={t("app.newSession")}
        aria-label={t("app.newSession")}
        onClick={() => void actions.sessions.createDraft(projectId)}
      >
        <Plus size={size} aria-hidden="true" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={chevronClassName}
            title={t("app.newSessionMenu")}
            aria-label={t("app.newSessionMenu")}
          >
            <ChevronDown size={10} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
          <DropdownMenuItem onSelect={() => void actions.sessions.createDraft(projectId)}>
            {t("app.newNormalSession")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void actions.sessions.createAnonymous(projectId)}>
            {t("app.newAnonymousSession")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
