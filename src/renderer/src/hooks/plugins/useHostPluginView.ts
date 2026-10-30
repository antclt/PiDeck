import { useEffect, useRef, useState, type RefObject } from "react";
import type { HostPluginContext } from "../../../../shared/types/hostPlugin";
import { desktopApi } from "../../desktopApi";
import { HOST_PLUGIN_THEME_TOKENS } from "./hostPluginTokens";

/** 创建型 API 需要的额外属性：全局 WebviewElement（types.d.ts）只声明了方法面。 */
type CreatableWebview = WebviewElement & { src: string; partition: string };

/** 插件面板是页面内 <webview>（与内置浏览器同层叠模型，可被弹层正常覆盖），布局跟随 DOM 天然同步。 */
function contextInput(scope: { projectId?: string; sessionId?: string }): HostPluginContext {
	const root = document.documentElement;
	const style = getComputedStyle(root);
	// 字体 token 可能来自用户自定义字体（原样写入 CSS），先按 policy 的同一组边界筛掉非法值：
	// 一个坏值不该让整次 context 更新被拒、把面板卡在 invalid-context。
	const tokens = Object.fromEntries(HOST_PLUGIN_THEME_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()] as const).filter(([, value]) => value.length > 0 && value.length <= 400 && !/[;{}<>\u0000-\u001f]/.test(value)));
	return { ...scope, locale: root.lang.startsWith("zh") ? "zh-CN" : "en-US", theme: root.dataset.theme === "light" ? "light" : "dark", tokens };
}

/** Pairs guest lifetime with the panel host element, rejecting late mounts after close/switch/StrictMode cleanup. */
export function useHostPluginView(element: RefObject<HTMLDivElement | null>, pluginId: string, panelId: string, projectId?: string, sessionId?: string) {
	const scope = useRef({ projectId, sessionId });
	scope.current = { projectId, sessionId };
	const synchronize = useRef<(() => void) | undefined>(undefined);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		const target = element.current;
		if (!target) return;
		let disposed = false;
		let instanceId: string | undefined;
		let guest: WebviewElement | undefined;
		let frame = 0;
		const fail = (code: string) => {
			if (!disposed) {
				setError(code);
				setLoading(false);
			}
		};
		const update = () => {
			if (disposed || !instanceId) return;
			void desktopApi.hostPlugins
				.update(instanceId, contextInput(scope.current))
				.then((result) => {
					if (!result.ok) fail(result.code);
				})
				.catch(() => fail("plugin-host-unavailable"));
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		};
		synchronize.current = schedule;
		const appearance = new MutationObserver(schedule);
		// 宿主插件面板跟着肤色同步：外观拆成两维后 data-palette 也会变（只换色不换形状），
		// 漏听会导致切配色后插件面板还停在上旧色板
		appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-appearance", "data-palette", "data-accent", "lang"] });
		void desktopApi.hostPlugins
			.mount({ pluginId, panelId, context: contextInput(scope.current) })
			.then(async (result) => {
				if (!result.ok) {
					fail(result.code);
					return;
				}
				if (disposed) {
					await desktopApi.hostPlugins.unmount(result.value.instanceId);
					return;
				}
				instanceId = result.value.instanceId;
				// 必须先 mount 成功再创建 webview：窗口 attach 策略只放行指向活实例的 host-plugin:<id> partition。
				const view = document.createElement("webview") as CreatableWebview;
				view.src = result.value.entryUrl;
				view.partition = `host-plugin:${instanceId}`;
				view.className = "h-full w-full";
				view.addEventListener("dom-ready", () => {
					if (!disposed) setLoading(false);
				});
				view.addEventListener("did-fail-load", () => fail("plugin-load-failed"));
				view.addEventListener("destroyed", () => {
					if (!disposed) fail("plugin-load-failed");
				});
				guest = view;
				target.appendChild(view);
			})
			.catch(() => fail("plugin-host-unavailable"));
		return () => {
			disposed = true;
			synchronize.current = undefined;
			cancelAnimationFrame(frame);
			appearance.disconnect();
			guest?.remove();
			if (instanceId) void desktopApi.hostPlugins.unmount(instanceId).catch(() => undefined);
		};
	}, [element, pluginId, panelId]);
	useEffect(() => synchronize.current?.(), [projectId, sessionId]);
	return { error, loading };
}
