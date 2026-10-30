/**
 * 会话内查找入口的快捷键提示（Wave 3 §5：搜索入口统一「快捷键提示」语义）。
 *
 * 背景：会话查找有两条入口——SessionHeader 放大镜按钮与 Ctrl/Cmd+Shift+F 快捷键
 * （写同一份 signal）。快捷键键位可被用户在设置里改绑（useShortcutBindings），
 * 按钮的 title/aria 若写死「Ctrl+Shift+F」会在改绑后说谎。
 *
 * QuickMessageMenu 已有同款语义（tooltip 带生效键位 + aria-keyshortcuts 用 ARIA 语法），
 * 这里复用同一套：title 显示生效键位，aria-keyshortcuts 用 toAriaKeyShortcuts 输出
 * （Control+Shift+F 这种 ARIA 语法，不能直接挂展示用的 ⌘⇧F）。
 */
import { useShortcutBindings } from "../../hooks/useShortcutBindings";
import { formatAccelerator, toAriaKeyShortcuts } from "../../../../shared/shortcuts";
import { t } from "../../i18n";

export function useSessionFindShortcutHint(): { kbd: string | undefined; aria: string | undefined } {
	const { bindings, platform } = useShortcutBindings();
	const find = bindings?.findInSession;
	if (!find) return { kbd: undefined, aria: undefined };
	return {
		kbd: formatAccelerator(find, platform),
		aria: toAriaKeyShortcuts(find, platform),
	};
}

export function sessionFindTriggerTitle(kbd: string | undefined): string {
	return kbd ? `${t("sessionFind.open")} (${kbd})` : t("sessionFind.open");
}
