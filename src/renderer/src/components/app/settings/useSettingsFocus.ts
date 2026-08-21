import { useEffect } from "react";
import { useAtom } from "jotai";
import { settingsFocusAtom, type SettingsTabId } from "../../../atoms";

/**
 * 消费一次性设置焦点：切到目标 tab，等 lazy tab 挂上后再滚到分区。
 * Git「去设置」等深链依赖这条路径；消费后必须清空 atom，否则下次侧栏打开仍会抢走 tab。
 */
export function useSettingsFocus(
	activeTab: SettingsTabId,
	setActiveTab: (tab: SettingsTabId) => void,
	persistTab: (tab: SettingsTabId) => void,
): void {
	const [focusTarget, setFocusTarget] = useAtom(settingsFocusAtom);

	useEffect(() => {
		if (!focusTarget) return;
		if (activeTab !== focusTarget.tab) {
			setActiveTab(focusTarget.tab);
			persistTab(focusTarget.tab);
			return;
		}
		const section = focusTarget.section;
		if (!section) {
			setFocusTarget(null);
			return;
		}
		const elementId = `settings-section-${section}`;
		let cancelled = false;
		let timer = 0;
		const deadline = Date.now() + 2000;
		const tryScroll = () => {
			if (cancelled) return;
			const el = document.getElementById(elementId);
			if (el) {
				el.scrollIntoView({ block: "start", behavior: "smooth" });
				setFocusTarget(null);
				return;
			}
			if (Date.now() < deadline) {
				timer = window.setTimeout(tryScroll, 50);
				return;
			}
			setFocusTarget(null);
		};
		timer = window.setTimeout(tryScroll, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [focusTarget, activeTab, persistTab, setActiveTab, setFocusTarget]);
}
