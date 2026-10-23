/**
 * 页面内快照采集脚本。
 *
 * 关键约束：这个函数必须**自包含**（不引用模块作用域的常量/函数），
 * 因为它会被 toString() 后注入 webview 主世界执行；外部标识符在页面里不存在。
 * 因此辅助函数都内嵌在函数体内，选择器也写死在里面。
 */

export type SnapshotScriptOptions = {
	maxElements: number;
	includeBoxes: boolean;
};

export function collectBrowserSnapshotInPage(rawOptions: { maxElements?: unknown; includeBoxes?: unknown }): unknown {
	const maxElements = typeof rawOptions.maxElements === "number" && rawOptions.maxElements > 0 ? Math.floor(rawOptions.maxElements) : 200;
	const includeBoxes = rawOptions.includeBoxes === true;
	const selector = "a[href], button, input:not([type='hidden']), textarea, select, summary, label, [role], [contenteditable=''], [contenteditable='true'], [onclick], [tabindex]:not([tabindex='-1'])";
	const MAX_SCAN = 4000;
	const MAX_ROOTS = 30;

	const isVisible = (el: Element): boolean => {
		const style = window.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};

	const roleOf = (el: Element): string => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "textarea") return "textbox";
		if (tag === "select") return "combobox";
		if (tag === "label") return "text";
		if (tag === "input") {
			const type = (el.getAttribute("type") || "text").toLowerCase();
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (type === "submit" || type === "button" || type === "reset") return "button";
			if (type === "search") return "searchbox";
			return "textbox";
		}
		if (el instanceof HTMLElement && el.isContentEditable) return "textbox";
		return tag;
	};

	const nameOf = (el: Element): string => {
		const ariaLabel = el.getAttribute("aria-label");
		if (ariaLabel && ariaLabel.trim()) return ariaLabel;
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const firstId = labelledBy.split(/\s+/)[0];
			const labelNode = firstId ? document.getElementById(firstId) : null;
			if (labelNode && labelNode.innerText) return labelNode.innerText;
		}
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
			const labels = el.labels;
			if (labels && labels.length > 0 && labels[0].innerText) return labels[0].innerText;
		}
		const placeholder = el.getAttribute("placeholder");
		if (placeholder && placeholder.trim()) return placeholder;
		const title = el.getAttribute("title");
		if (title && title.trim()) return title;
		const alt = el.getAttribute("alt");
		if (alt && alt.trim()) return alt;
		if (el instanceof HTMLElement) return el.innerText || el.textContent || "";
		return el.textContent || "";
	};

	const valueOf = (el: Element): string => {
		if (el instanceof HTMLInputElement) {
			if (el.type === "password") return "[password]";
			if (el.type === "file") return "[file]";
			return el.value;
		}
		if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
		if (el instanceof HTMLElement && el.isContentEditable) return el.innerText;
		return "";
	};

	// 收集 document + 开放 shadow root：closed shadow root 无法访问，v1 明确不支持。
	const roots: Array<Document | ShadowRoot> = [];
	const pendingRoots: Array<Document | ShadowRoot> = [document];
	for (let rootIndex = 0; rootIndex < pendingRoots.length && roots.length < MAX_ROOTS; rootIndex += 1) {
		const root = pendingRoots[rootIndex];
		roots.push(root);
		const all = root.querySelectorAll("*");
		for (let i = 0; i < all.length && i < MAX_SCAN; i += 1) {
			const shadow = all[i].shadowRoot;
			if (shadow) pendingRoots.push(shadow);
		}
	}

	// 清掉上一轮 ref，避免页面残留属性让旧 ref 指到新元素。
	for (const root of roots) {
		const stale = root.querySelectorAll("[data-pideck-ref]");
		for (let i = 0; i < stale.length; i += 1) stale[i].removeAttribute("data-pideck-ref");
	}

	const seen = new Set<Element>();
	const candidates: Element[] = [];
	for (const root of roots) {
		const matches = root.querySelectorAll(selector);
		for (let i = 0; i < matches.length; i += 1) {
			const candidate = matches[i];
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			candidates.push(candidate);
		}
	}

	const elements: Array<Record<string, unknown>> = [];
	let visibleCount = 0;
	for (const el of candidates) {
		if (!isVisible(el)) continue;
		visibleCount += 1;
		if (elements.length >= maxElements) continue;
		const ref = `e${elements.length + 1}`;
		el.setAttribute("data-pideck-ref", ref);
		const rect = el.getBoundingClientRect();
		const node: Record<string, unknown> = {
			ref,
			role: roleOf(el),
			name: nameOf(el).slice(0, 200),
			tag: el.tagName.toLowerCase(),
		};
		const value = valueOf(el);
		if (value) node.value = value.slice(0, 120);
		if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") node.disabled = true;
		if (includeBoxes) node.box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		elements.push(node);
	}

	return {
		url: location.href,
		title: document.title,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		scroll: { x: window.scrollX, y: window.scrollY },
		devicePixelRatio: window.devicePixelRatio,
		iframeCount: document.querySelectorAll("iframe").length,
		elements,
		totalElements: visibleCount,
		truncated: visibleCount > elements.length,
	};
}

/** 生成可注入 Runtime.evaluate 的表达式（参数经 JSON 序列化，避免注入页面代码）。 */
export function buildSnapshotExpression(options: SnapshotScriptOptions): string {
	const payload = JSON.stringify({ maxElements: options.maxElements, includeBoxes: options.includeBoxes });
	return `(${collectBrowserSnapshotInPage.toString()})(${payload})`;
}
