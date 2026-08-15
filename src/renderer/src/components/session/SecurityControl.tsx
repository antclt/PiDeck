import type { AgentBackend } from "../../../../shared/types";
import { DshPermissionMenu } from "./DshPermissionMenu";
import { SecurityLevelMenu } from "./SecurityLevelMenu";

/**
 * 底栏安全控制位统一入口（C20）：
 * - pi 后端：内置安全等级菜单（SecurityLevelMenu，SecurityStore 会话级覆盖，安全门热更新）；
 * - DSH 后端：权限预设菜单（DshPermissionMenu，host 侧 /permission，dsh-web 同款预设）。
 * 新增后端（如未来 Codex 运行时）只在这里注册控制位，不再在 ComposerArea 写 if/else。
 */
export function SecurityControl(props: {
  sessionId: string;
  backend?: AgentBackend;
  disabled?: boolean;
}) {
  if (props.backend === "dsh") {
    return <DshPermissionMenu sessionId={props.sessionId} disabled={props.disabled} />;
  }
  return <SecurityLevelMenu sessionId={props.sessionId} disabled={props.disabled} />;
}
