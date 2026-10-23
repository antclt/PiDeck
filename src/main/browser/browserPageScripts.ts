/**
 * 页面内小脚本构造器：只做"取状态 / 解析 ref / 滚动 / 聚焦"这类无副作用或可重复执行的操作。
 * 所有参数都经 JSON.stringify 注入，ref 在调用前已由 BrowserController 用 /^e\d+$/ 校验。
 */

const REF_SELECTOR = (ref: string) => `[data-pideck-ref=${JSON.stringify(ref)}]`;

export function buildPageStateExpression(): string {
	return "(() => ({ url: location.href, title: document.title, viewport: { width: window.innerWidth, height: window.innerHeight }, scroll: { x: window.scrollX, y: window.scrollY }, devicePixelRatio: window.devicePixelRatio, iframeCount: document.querySelectorAll('iframe').length }))()";
}

export type ResolvedRefNode = {
	found: boolean;
	visible?: boolean;
	disabled?: boolean;
	tag?: string;
	name?: string;
	rect?: { x: number; y: number; width: number; height: number };
};

export function buildResolveRefExpression(ref: string): string {
	const selector = REF_SELECTOR(ref);
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return { found: false };
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
		const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
		const label = el.getAttribute("aria-label") || (el instanceof HTMLElement ? el.innerText : el.textContent) || "";
		return { found: true, visible, disabled, tag: el.tagName.toLowerCase(), name: label.replace(/\s+/g, " ").trim().slice(0, 120), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
	})()`;
}

/** 把元素滚到视口中央，点击前调用，保证 rect 是视口内坐标。 */
/** 仅聚焦（不清空）：输入动作前的标准准备。 */
export function buildFocusExpression(ref: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))}); if (!el) return false; if (el instanceof HTMLElement) el.focus(); return true; })()`;
}

/** 把元素滚到视口中央，点击前调用，保证 rect 是视口内坐标。 */
export function buildScrollIntoViewExpression(ref: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); return true; })()`;
}

/** 聚焦并全选（清空输入框/可编辑区的前置动作）。 */
export function buildFocusAndSelectExpression(ref: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))});
		if (!el) return false;
		if (el instanceof HTMLElement) el.focus();
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return true; }
		if (el instanceof HTMLElement && el.isContentEditable) {
			const range = document.createRange();
			range.selectNodeContents(el);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return true;
		}
		return true;
	})()`;
}

/** CDP 不可用时的降级点击：DOM click()（非 trusted、无 hover 序列）。 */
export function buildFallbackClickExpression(ref: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))}); if (!el) return false; if (el instanceof HTMLElement) el.click(); return true; })()`;
}

/** 降级输入：直接写 value / textContent 并派发 input+change。 */
export function buildFallbackTypeExpression(ref: string, text: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))});
		if (!el) return false;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = ${JSON.stringify(text)};
		else if (el instanceof HTMLElement && el.isContentEditable) el.textContent = ${JSON.stringify(text)};
		else return false;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	})()`;
}

export function buildFallbackScrollExpression(deltaX: number, deltaY: number): string {
	return `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}), true`;
}

export function buildFallbackKeyExpression(key: string): string {
	return `(() => { const el = document.activeElement || document.body; if (!el) return false; el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })); el.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`;
}
