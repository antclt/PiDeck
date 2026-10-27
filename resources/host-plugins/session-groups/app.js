// 会话分组 / Session Groups — PiDeck 宿主插件
// 只用 window.pideck 能力面：context / sessions / storage / workbench / onEvent。
// 会话数据只读；分组关系存插件私有 storage，按 projectId 隔离。
"use strict";

const pideck = window.pideck;

/* ---------- 文案（中英两套，跟随 context.locale） ---------- */

const STR = {
	"zh-CN": {
		newGroup: "新建分组",
		groupNamePlaceholder: "分组名称",
		ungrouped: "未分组",
		addSessions: "添加会话",
		rename: "重命名",
		deleteGroup: "删除分组",
		removeSession: "移出分组",
		confirmDelete: "删除该分组？组内会话将回到未分组。",
		delete: "删除",
		cancel: "取消",
		save: "保存",
		searchPlaceholder: "搜索会话标题…",
		sessionsUnit: "个会话",
		empty: "还没有分组",
		emptyHint: "点右上角「新建分组」，把有关联的会话放到一起。",
		emptyGroup: "空分组，点「添加会话」把会话放进来。",
		noProject: "未选择项目",
		noProjectHint: "请先在 PiDeck 中选择一个项目。",
		justNow: "刚刚",
		minAgo: "分钟前",
		hourAgo: "小时前",
		dayAgo: "天前",
		loadError: "加载会话目录失败：",
		actionError: "操作失败：",
		modalHint: "勾选即归入本分组，自动从原分组移出",
		modalHintUngrouped: "勾选即移回未分组",
		inGroup: "当前在",
		untitled: "（无标题）",
		activeNow: "活跃中",
		currentTag: "当前",
		detailTitle: "会话详情",
		fieldGroup: "所属分组",
		fieldModel: "模型",
		fieldCreatedAt: "创建时间",
		fieldUpdatedAt: "更新时间",
		fieldStatus: "状态",
		fieldId: "会话 ID",
		inactive: "静默",
		unreadableTag: "不可读",
		currentLabel: "当前会话",
		expandAll: "全部展开",
		collapseAll: "全部收起",
		noMatch: "没有匹配的会话",
		clearSearch: "清空搜索",
	},
	"en-US": {
		newGroup: "New group",
		groupNamePlaceholder: "Group name",
		ungrouped: "Ungrouped",
		addSessions: "Add sessions",
		rename: "Rename",
		deleteGroup: "Delete group",
		removeSession: "Remove from group",
		confirmDelete: "Delete this group? Its sessions return to ungrouped.",
		delete: "Delete",
		cancel: "Cancel",
		save: "Save",
		searchPlaceholder: "Search session titles…",
		sessionsUnit: "sessions",
		empty: "No groups yet",
		emptyHint: "Click “New group” to gather related sessions together.",
		emptyGroup: "Empty group. Click “Add sessions” to put sessions in.",
		noProject: "No project selected",
		noProjectHint: "Select a project in PiDeck first.",
		justNow: "just now",
		minAgo: "min ago",
		hourAgo: "h ago",
		dayAgo: "d ago",
		loadError: "Failed to load session catalog: ",
		actionError: "Action failed: ",
		modalHint: "Checked sessions join this group and leave their old one",
		modalHintUngrouped: "Checked sessions return to ungrouped",
		inGroup: "in",
		untitled: "(untitled)",
		activeNow: "Active",
		currentTag: "Current",
		detailTitle: "Session details",
		fieldGroup: "Group",
		fieldModel: "Model",
		fieldCreatedAt: "Created",
		fieldUpdatedAt: "Updated",
		fieldStatus: "Status",
		fieldId: "Session ID",
		inactive: "Idle",
		unreadableTag: "Unreadable",
		currentLabel: "Current session",
		expandAll: "Expand all",
		collapseAll: "Collapse all",
		noMatch: "No matching sessions",
		clearSearch: "Clear search",
	},
};

let L = STR["zh-CN"];

/* ---------- 状态 ---------- */

const state = {
	projectId: undefined,
	projectName: undefined,
	currentSessionId: undefined,
	locale: "zh-CN",
	sessions: new Map(), // id -> HostPluginSession（目录元信息）
	data: { v: 1, groups: [], collapsed: [] }, // 持久化的分组数据
	storageKey: null,
	ready: false,
};

// 瞬时 UI 状态（不持久化）
let pendingNew = false;
let pendingRenameId = null; // 分组 id
let pendingDeleteId = null; // 分组 id

// 添加会话弹层状态
const modal = { target: undefined, was: new Set(), now: new Set(), open: false };

// 拖拽状态：被拖会话 id（作为 dataTransfer 的兑底）
let draggingId = null;

// 快速搜索：标题关键词过滤（保留分组结构，命中组自动展开、无命中组隐藏）
let filterQuery = "";

function matchesQuery(id) {
	if (!filterQuery) return true;
	const s = state.sessions.get(id);
	return Boolean(s && (s.title || "").toLowerCase().includes(filterQuery));
}

/* ---------- 工具 ---------- */

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	return node;
}

// projectId 不能直接当 storage key（键名只允许 [a-zA-Z0-9_.-]{1,80}）：
// 合法且够短就直接用，否则取稳定的 FNV-1a 哈希。
function safeKey(projectId) {
	const s = String(projectId ?? "none");
	if (/^[a-zA-Z0-9_.-]{1,64}$/.test(s)) return s;
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16);
}

function storageKeyFor(projectId) {
	return "grp." + safeKey(projectId);
}

function newGroupId() {
	return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 「活跃中」判定：updatedAt 距今 ≤ 10 分钟（事件驱动刷新 + 每分钟静默重绘）
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

function isRecentlyActive(s) {
	const t = typeof s.updatedAt === "number" ? s.updatedAt : Date.parse(s.updatedAt);
	return Number.isFinite(t) && Date.now() - t <= ACTIVE_WINDOW_MS;
}

// 把宿主下发的主题 token（--color-*）写到 <html> 内联样式上。
// 不能只依赖宿主的 insertCSS 注入：在 webview 完成导航前插入容易丢失，
// 面板就只剩 CSS 缺省色；内联变量优先级最高且随 context.changed 实时刷新。
const appliedTokenNames = new Set();
function applyTokens(tokens) {
	const style = document.documentElement.style;
	if (!tokens || typeof tokens !== "object") return;
	for (const [name, value] of Object.entries(tokens)) {
		if (typeof name !== "string" || typeof value !== "string" || !value) continue;
		const prop = name.startsWith("--") ? name : "--" + name;
		style.setProperty(prop, value);
		appliedTokenNames.add(prop);
	}
}

function fmtTime(ts) {
	const t = typeof ts === "number" ? ts : Date.parse(ts);
	if (!Number.isFinite(t)) return "";
	const diff = Date.now() - t;
	if (diff < 60_000) return L.justNow;
	if (diff < 3_600_000) return Math.floor(diff / 60_000) + L.minAgo;
	if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + L.hourAgo;
	return Math.floor(diff / 86_400_000) + L.dayAgo;
}

// 宽松档完整时间：更新到分钟，创建到日期
function fmtDateTime(ts) {
	const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
	if (Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function fmtDate(ts) {
	const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
	if (Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

let statusTimer = null;
function setStatus(msg, isError) {
	const node = $("status");
	if (!msg) {
		node.hidden = true;
		node.textContent = "";
		return;
	}
	node.textContent = msg;
	node.classList.toggle("status-error", Boolean(isError));
	node.hidden = false;
	clearTimeout(statusTimer);
	if (!isError) statusTimer = setTimeout(() => setStatus(null), 2500);
}

function actionError(err) {
	setStatus(L.actionError + (err && err.message ? err.message : String(err)), true);
}

/* ---------- 数据读写 ---------- */

function sortedGroups() {
	return [...state.data.groups].sort((a, b) => b.createdAt - a.createdAt); // 新组在上
}

function groupById(id) {
	return state.data.groups.find((g) => g.id === id) ?? null;
}

function groupOf(sessionId) {
	return state.data.groups.find((g) => g.sessionIds.includes(sessionId)) ?? null;
}

function ungroupedIds() {
	const grouped = new Set();
	for (const g of state.data.groups) for (const id of g.sessionIds) grouped.add(id);
	return [...state.sessions.keys()].filter((id) => !grouped.has(id));
}

// 会话只属一个组：assign(id, null) = 移回未分组
function assign(sessionId, targetId) {
	for (const g of state.data.groups) {
		if (g.id !== targetId) g.sessionIds = g.sessionIds.filter((x) => x !== sessionId);
	}
	if (targetId != null) {
		const g = groupById(targetId);
		if (g && !g.sessionIds.includes(sessionId)) g.sessionIds.push(sessionId);
	}
}

async function save() {
	if (!state.storageKey) return;
	try {
		await pideck.storage.set(state.storageKey, state.data);
	} catch (err) {
		actionError(err);
	}
}

async function loadProjectData(projectId) {
	const key = storageKeyFor(projectId);
	state.storageKey = key;
	state.data = { v: 1, groups: [], collapsed: [] };
	try {
		const raw = await pideck.storage.get(key);
		if (raw && typeof raw === "object" && Array.isArray(raw.groups)) {
			state.data = {
				v: 1,
				groups: raw.groups
					.filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
					.map((g) => ({
						id: g.id,
						name: g.name,
						createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
						sessionIds: Array.isArray(g.sessionIds) ? g.sessionIds.filter((x) => typeof x === "string") : [],
					})),
				collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((x) => typeof x === "string") : [],
			};
		}
	} catch (err) {
		actionError(err);
	}
}

// 分页拉全当前项目会话目录（每页 100；防死循环：nextOffset 不前进就停）
async function loadCatalog() {
	const map = new Map();
	let offset = 0;
	let guard = 0;
	while (guard++ < 2000) {
		const page = await pideck.sessions.list(offset);
		for (const s of page.sessions || []) map.set(s.id, s);
		if (page.nextOffset == null) break;
		if (page.nextOffset === offset) break; // 异常防御：游标不动就停
		offset = page.nextOffset;
	}
	state.sessions = map;
}

// 会话被删/归档后：清掉失效引用，改名后：标题随目录自然更新
function pruneGroups() {
	let changed = false;
	for (const g of state.data.groups) {
		const before = g.sessionIds.length;
		g.sessionIds = g.sessionIds.filter((id) => state.sessions.has(id));
		if (g.sessionIds.length !== before) changed = true;
	}
	// "__ungrouped__" 是未分组区的伪 id，也要保留
	state.data.collapsed = state.data.collapsed.filter((id) => id === "__ungrouped__" || groupById(id));
	return changed;
}

/* ---------- 上下文 / 事件 ---------- */

async function applyContext(ctx, projectChanged) {
	state.projectId = ctx.projectId;
	state.projectName = ctx.projectName;
	state.currentSessionId = ctx.sessionId;
	state.locale = ctx.locale === "en-US" ? "en-US" : "zh-CN";
	L = STR[state.locale];
	// 把主题写到 <html data-theme>，CSS 据此联动错误色/遮罩等 --color-* 没覆盖的语义色
	document.documentElement.dataset.theme = ctx.theme === "light" ? "light" : "dark";
	// 宿主 token 直接内联到 <html>：不依赖宿主的 insertCSS 时机，切主题时同步刷新
	applyTokens(ctx.tokens);
	pendingNew = false;
	pendingRenameId = null;
	pendingDeleteId = null;
	// 切项目时清空搜索，避免拿旧关键词过滤新项目的会话
	filterQuery = "";
	const searchInput = $("search-input");
	if (searchInput) searchInput.value = "";
	closeModal(false);
	renderStaticText();
	if (!ctx.projectId) {
		state.sessions = new Map();
		state.data = { v: 1, groups: [], collapsed: [] };
		state.storageKey = null;
		render();
		return;
	}
	if (projectChanged || !state.ready) {
		try {
			await loadProjectData(ctx.projectId);
			await loadCatalog();
			if (pruneGroups()) await save();
		} catch (err) {
			setStatus(L.loadError + (err && err.message ? err.message : ""), true);
		}
	}
	render();
}

async function refreshSession(sessionId) {
	try {
		const s = await pideck.sessions.get(sessionId);
		if (s) state.sessions.set(s.id, s);
	} catch {
		// 会话可能刚被删除，目录事件会兜底
	}
}

async function handleEvent(ev) {
	if (!ev || !ev.type) return;
	try {
		if (ev.type === "context.changed") {
			await applyContext(ev.context || {}, (ev.context || {}).projectId !== state.projectId);
		} else if (ev.type === "sessions.changed") {
			const d = ev.detail || {};
			if (d.catalogChanged) {
				await loadCatalog();
				if (pruneGroups()) await save();
				render();
			} else if (d.sessionId) {
				await refreshSession(d.sessionId);
				render();
			}
		}
	} catch (err) {
		actionError(err);
	}
}

/* ---------- 渲染 ---------- */

function renderStaticText() {
	document.documentElement.lang = state.locale;
	$("btn-new").textContent = L.newGroup;
	$("new-group-input").placeholder = L.groupNamePlaceholder;
	$("new-group-ok").textContent = L.save;
	$("new-group-cancel").textContent = L.cancel;
	$("modal-search").placeholder = L.searchPlaceholder;
	$("search-input").placeholder = L.searchPlaceholder;
	const searchClear = $("search-clear");
	if (searchClear) searchClear.title = L.clearSearch;
	$("modal-cancel").textContent = L.cancel;
	$("modal-save").textContent = L.save;
	const infoClose = $("info-close");
	if (infoClose) infoClose.title = L.cancel;
}

function sessionNode(id, inGroup) {
	const s = state.sessions.get(id);
	if (!s) return null; // 目录里已不存在的（理论上已被 prune）
	const node = el("div", "session" + (id === state.currentSessionId ? " current" : ""));
	node.dataset.sessionId = id;

	const main = el("div", "session-main");
	const titleRow = el("div", "session-title-row");
	if (isRecentlyActive(s)) {
		const dot = el("span", "active-dot");
		dot.title = L.activeNow;
		titleRow.append(dot);
	}
	titleRow.append(el("div", "session-title", s.title || L.untitled));
	if (id === state.currentSessionId) titleRow.append(el("span", "tag current-tag", L.currentTag));
	// 固定紧凑单行：标题行尾带相对时间
	const rel = fmtTime(s.updatedAt);
	if (rel) titleRow.append(el("span", "compact-time", rel));
	if (!s.readable) node.classList.add("unreadable");
	main.append(titleRow);
	main.addEventListener("click", async () => {
		try {
			await pideck.workbench.navigate(id);
		} catch (err) {
			actionError(err);
		}
	});
	node.append(main);

	// 拖拽归组：整行可拖，落到某个分组卡片（或未分组区）完成归组
	node.draggable = true;
	node.addEventListener("dragstart", (e) => {
		draggingId = id;
		if (e.dataTransfer) {
			e.dataTransfer.setData("text/plain", id);
			e.dataTransfer.effectAllowed = "move";
		}
		node.classList.add("dragging");
	});
	node.addEventListener("dragend", () => {
		draggingId = null;
		node.classList.remove("dragging");
	});

	// 会话详情：ⓘ 弹层卡片展示全部字段
	const infoBtn = el("button", "icon-btn session-info", "ⓘ");
	infoBtn.type = "button";
	infoBtn.title = L.detailTitle;
	infoBtn.addEventListener("click", () => openInfoModal(id));
	node.append(infoBtn);

	if (inGroup) {
		const removeBtn = el("button", "icon-btn session-remove", "×");
		removeBtn.type = "button";
		removeBtn.title = L.removeSession;
		removeBtn.addEventListener("click", async () => {
			assign(id, null);
			await save();
			render();
		});
		node.append(removeBtn);
	}
	return node;
}

function sessionList(ids, inGroup) {
	const body = el("div", "session-list");
	const sorted = ids
		.filter((id) => state.sessions.has(id))
		.sort((a, b) => {
			const ta = state.sessions.get(a)?.updatedAt ?? 0;
			const tb = state.sessions.get(b)?.updatedAt ?? 0;
			return (tb || 0) - (ta || 0); // 最近活跃在上
		});
	for (const id of sorted) {
		const n = sessionNode(id, inGroup);
		if (n) body.append(n);
	}
	return body;
}

// 分组卡片（含未分组区）作为拖放目标：拖会话进来即归组
function makeDropTarget(section, targetId) {
	section.addEventListener("dragover", (e) => {
		if (!draggingId) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		section.classList.add("drag-over");
	});
	section.addEventListener("dragleave", () => section.classList.remove("drag-over"));
	section.addEventListener("drop", async (e) => {
		e.preventDefault();
		section.classList.remove("drag-over");
		const id = draggingId || (e.dataTransfer ? e.dataTransfer.getData("text/plain") : null);
		draggingId = null;
		if (!id || !state.sessions.has(id)) return;
		const from = groupOf(id);
		const sameTarget = from ? from.id === targetId : targetId == null;
		if (sameTarget) return; // 原地放手，不动
		assign(id, targetId);
		await save();
		render();
	});
}

function groupNode(g, visibleIds) {
	// 搜索过滤时传入命中子集：强制展开、不计入折叠状态；null = 正常全量视图
	const ids = visibleIds ?? g.sessionIds;
	const collapsed = visibleIds == null && state.data.collapsed.includes(g.id);
	const section = el("section", "group" + (collapsed ? " collapsed" : ""));

	// --- 组头 ---
	const head = el("div", "group-head");
	const chevron = el("button", "icon-btn chevron", "▸");
	chevron.type = "button";
	chevron.addEventListener("click", () => toggleCollapse(g.id));

	if (pendingRenameId === g.id) {
		const input = el("input", "text-input rename-input");
		input.type = "text";
		input.value = g.name;
		input.maxLength = 80;
		const ok = el("button", "btn primary btn-s", L.save);
		ok.type = "button";
		ok.addEventListener("click", async () => {
			const name = input.value.trim();
			if (name) {
				g.name = name;
				pendingRenameId = null;
				await save();
			}
			render();
		});
		const cancel = el("button", "btn btn-s", L.cancel);
		cancel.type = "button";
		cancel.addEventListener("click", () => {
			pendingRenameId = null;
			render();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") ok.click();
			if (e.key === "Escape") cancel.click();
		});
		head.append(chevron, input, ok, cancel);
		// 展开以便看到上下文
		section.classList.remove("collapsed");
	} else {
		head.append(chevron, el("span", "group-name", g.name), el("span", "group-count", ids.length + " " + L.sessionsUnit));
		const actions = el("span", "group-actions");
		const addBtn = el("button", "icon-btn", "＋");
		addBtn.type = "button";
		addBtn.title = L.addSessions;
		addBtn.addEventListener("click", () => openModal(g.id));
		const renameBtn = el("button", "icon-btn", "✎");
		renameBtn.type = "button";
		renameBtn.title = L.rename;
		renameBtn.addEventListener("click", () => {
			pendingRenameId = g.id;
			pendingDeleteId = null;
			render();
		});
		const deleteBtn = el("button", "icon-btn", "🗑");
		deleteBtn.type = "button";
		deleteBtn.title = L.deleteGroup;
		deleteBtn.addEventListener("click", () => {
			pendingDeleteId = g.id;
			pendingRenameId = null;
			render();
		});
		actions.append(addBtn, renameBtn, deleteBtn);
		head.append(actions);
	}
	section.append(head);

	// --- 删除确认条 ---
	if (pendingDeleteId === g.id) {
		const bar = el("div", "confirm-bar");
		bar.append(el("span", "confirm-text", L.confirmDelete));
		const del = el("button", "btn danger btn-s", L.delete);
		del.type = "button";
		del.addEventListener("click", async () => {
			state.data.groups = state.data.groups.filter((x) => x.id !== g.id);
			state.data.collapsed = state.data.collapsed.filter((x) => x !== g.id);
			pendingDeleteId = null;
			await save(); // 组删了，会话自然回未分组
			render();
		});
		const cancel = el("button", "btn btn-s", L.cancel);
		cancel.type = "button";
		cancel.addEventListener("click", () => {
			pendingDeleteId = null;
			render();
		});
		bar.append(del, cancel);
		section.append(bar);
	}

	// --- 组体：会话列表 ---
	if (!collapsed && pendingRenameId !== g.id) {
		const body = sessionList(ids, true);
		if (ids.length === 0) body.append(el("div", "hint", L.emptyGroup));
		section.append(body);
	}
	makeDropTarget(section, g.id);
	return section;
}

function ungroupedNode(visibleIds) {
	const ids = visibleIds ?? ungroupedIds();
	const collapsed = visibleIds == null && state.data.collapsed.includes("__ungrouped__");
	const section = el("section", "group ungrouped" + (collapsed ? " collapsed" : ""));
	const head = el("div", "group-head");
	const chevron = el("button", "icon-btn chevron", "▸");
	chevron.type = "button";
	chevron.addEventListener("click", () => toggleCollapse("__ungrouped__"));
	head.append(chevron, el("span", "group-name", L.ungrouped), el("span", "group-count", ids.length + " " + L.sessionsUnit));
	const actions = el("span", "group-actions");
	const addBtn = el("button", "icon-btn", "＋");
	addBtn.type = "button";
	addBtn.title = L.addSessions;
	addBtn.addEventListener("click", () => openModal(null));
	actions.append(addBtn);
	head.append(actions);
	section.append(head);
	if (!collapsed) {
		const body = sessionList(ids, false);
		section.append(body);
	}
	makeDropTarget(section, null);
	return section;
}

async function toggleCollapse(groupId) {
	const list = state.data.collapsed;
	const i = list.indexOf(groupId);
	if (i >= 0) list.splice(i, 1);
	else list.push(groupId);
	await save();
	render();
}

// 一键展开/收起：有任一折叠就全部展开，否则全部收起（含未分组区）
function anyCollapsed() {
	return (
		state.data.collapsed.includes("__ungrouped__") ||
		state.data.groups.some((g) => state.data.collapsed.includes(g.id))
	);
}

function bindToggleAll() {
	const btn = $("btn-toggle-all");
	if (!btn) return;
	btn.addEventListener("click", async () => {
		if (!state.projectId) return;
		if (anyCollapsed()) state.data.collapsed = [];
		else state.data.collapsed = [...state.data.groups.map((g) => g.id), "__ungrouped__"];
		await save();
		render();
	});
}

function render() {
	$("project-name").textContent = state.projectName || L.noProject;
	const total = state.sessions.size;
	const matchCount = filterQuery
		? [...state.sessions.values()].filter((s) => (s.title || "").toLowerCase().includes(filterQuery)).length
		: total;
	$("project-count").textContent = state.projectId
		? (filterQuery ? matchCount + " / " + total + " " + L.sessionsUnit : total + " " + L.sessionsUnit)
		: "";
	$("btn-new").disabled = !state.projectId;
	const toggleAllBtn = $("btn-toggle-all");
	if (toggleAllBtn) {
		toggleAllBtn.disabled = !state.projectId;
		toggleAllBtn.textContent = anyCollapsed() ? L.expandAll : L.collapseAll;
	}
	const searchClear = $("search-clear");
	if (searchClear) searchClear.hidden = !filterQuery;
	$("new-group-row").hidden = !pendingNew;

	const container = $("groups");
	container.textContent = "";

	if (!state.projectId) {
		const hint = el("div", "empty-state");
		hint.append(el("div", "empty-title", L.noProject), el("div", "hint", L.noProjectHint));
		container.append(hint);
		return;
	}

	// 搜索过滤：保留分组结构，命中组自动展开，无命中的组/未分组隐藏
	if (filterQuery) {
		let shown = 0;
		for (const g of sortedGroups()) {
			const ids = g.sessionIds.filter(matchesQuery);
			if (ids.length === 0) continue;
			shown += ids.length;
			container.append(groupNode(g, ids));
		}
		const unIds = ungroupedIds().filter(matchesQuery);
		if (unIds.length > 0) {
			shown += unIds.length;
			container.append(ungroupedNode(unIds));
		}
		if (shown === 0) {
			const hint = el("div", "empty-state");
			hint.append(el("div", "empty-title", L.noMatch));
			container.append(hint);
		}
		return;
	}

	const groups = sortedGroups();
	if (groups.length === 0) {
		const hint = el("div", "empty-state");
		hint.append(el("div", "empty-title", L.empty), el("div", "hint", L.emptyHint));
		container.append(hint);
	}
	for (const g of groups) container.append(groupNode(g));
	container.append(ungroupedNode());
}

/* ---------- 新建分组 ---------- */

function bindNewGroup() {
	$("btn-new").addEventListener("click", () => {
		pendingNew = !pendingNew;
		render();
		if (pendingNew) {
			$("new-group-input").value = "";
			$("new-group-input").focus();
		}
	});
	$("new-group-cancel").addEventListener("click", () => {
		pendingNew = false;
		render();
	});
	const create = async () => {
		const name = $("new-group-input").value.trim();
		if (!name) return;
		state.data.groups.push({ id: newGroupId(), name, createdAt: Date.now(), sessionIds: [] });
		pendingNew = false;
		await save();
		render();
	};
	$("new-group-ok").addEventListener("click", create);
	$("new-group-input").addEventListener("keydown", (e) => {
		if (e.key === "Enter") create();
		if (e.key === "Escape") {
			pendingNew = false;
			render();
		}
	});
}

/* ---------- 会话详情弹层（ⓘ） ---------- */

function openInfoModal(id) {
	const s = state.sessions.get(id);
	if (!s) return;
	$("info-title").textContent = s.title || L.untitled;
	const body = $("info-body");
	body.textContent = "";
	const g = groupOf(id);
	const statusParts = [];
	if (id === state.currentSessionId) statusParts.push(L.currentLabel);
	if (isRecentlyActive(s)) statusParts.push(L.activeNow);
	if (!s.readable) statusParts.push(L.unreadableTag);
	const full = fmtDateTime(s.updatedAt);
	const created = fmtDate(s.createdAt);
	const rows = [
		[L.fieldGroup, g ? g.name : L.ungrouped],
		[L.fieldModel, s.model || "—"],
		[L.fieldCreatedAt, created || "—"],
		[L.fieldUpdatedAt, full ? full + "（" + fmtTime(s.updatedAt) + "）" : "—"],
		[L.fieldStatus, statusParts.length > 0 ? statusParts.join(" · ") : L.inactive],
		[L.fieldId, id],
	];
	for (const [label, value] of rows) {
		const row = el("div", "info-row");
		row.append(el("span", "info-label", label), el("span", "info-value", value));
		body.append(row);
	}
	$("info-overlay").hidden = false;
}

function closeInfoModal() {
	$("info-overlay").hidden = true;
}

function bindInfoModal() {
	const overlay = $("info-overlay");
	if (!overlay) return;
	$("info-close").addEventListener("click", closeInfoModal);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) closeInfoModal(); // 点遮罩关闭，点卡片内不关
	});
}

function bindSearch() {
	const input = $("search-input");
	const clear = $("search-clear");
	if (!input) return;
	input.addEventListener("input", () => {
		filterQuery = input.value.trim().toLowerCase();
		if (clear) clear.hidden = !filterQuery;
		render();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			input.value = "";
			filterQuery = "";
			if (clear) clear.hidden = true;
			render();
		}
	});
	if (clear) {
		clear.addEventListener("click", () => {
			input.value = "";
			filterQuery = "";
			clear.hidden = true;
			render();
		});
	}
}

/* ---------- 添加会话弹层 ---------- */

function openModal(targetId) {
	// targetId: 分组 id；null = 未分组
	modal.open = true;
	modal.target = targetId;
	modal.was = new Set(targetId ? groupById(targetId).sessionIds : ungroupedIds());
	modal.now = new Set(modal.was);
	const title = targetId ? groupById(targetId).name : L.ungrouped;
	$("modal-title").textContent = L.addSessions + " · " + title;
	$("modal-hint").textContent = targetId ? L.modalHint : L.modalHintUngrouped;
	$("modal-search").value = "";
	$("overlay").hidden = false;
	renderModalList();
	$("modal-search").focus();
}

function closeModal(rerender) {
	modal.open = false;
	modal.target = undefined;
	$("overlay").hidden = true;
	if (rerender) render();
}

function renderModalList() {
	const list = $("modal-list");
	list.textContent = "";
	const q = $("modal-search").value.trim().toLowerCase();
	const items = [...state.sessions.values()]
		.filter((s) => !q || (s.title || "").toLowerCase().includes(q))
		.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	for (const s of items) {
		const row = el("label", "modal-row");
		const box = el("input");
		box.type = "checkbox";
		box.checked = modal.now.has(s.id);
		box.addEventListener("change", () => {
			if (box.checked) modal.now.add(s.id);
			else modal.now.delete(s.id);
			$("modal-hint").textContent = ""; // 勾选后清掉提示，避免误导
		});
		const label = el("span", "modal-row-main");
		label.append(el("span", "session-title", s.title || L.untitled));
		const g = groupOf(s.id);
		if (g && (!modal.target || g.id !== modal.target)) {
			label.append(el("span", "tag", L.inGroup + g.name));
		}
		const meta = el("span", "session-meta", s.model ? s.model : "");
		const t = fmtTime(s.updatedAt);
		meta.textContent = meta.textContent && t ? meta.textContent + " · " + t : meta.textContent || t;
		label.append(meta);
		row.append(box, label);
		list.append(row);
	}
	if (items.length === 0) list.append(el("div", "hint", L.searchPlaceholder));
}

async function saveModal() {
	for (const id of modal.now) assign(id, modal.target ?? null);
	for (const id of modal.was) if (!modal.now.has(id)) assign(id, null);
	closeModal(false);
	await save();
	render();
}

function bindModal() {
	$("modal-close").addEventListener("click", () => closeModal(true));
	$("modal-cancel").addEventListener("click", () => closeModal(true));
	$("modal-save").addEventListener("click", () => saveModal().catch(actionError));
	$("modal-search").addEventListener("input", renderModalList);
	$("modal-search").addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeModal(true);
	});
	$("overlay").addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeModal(true);
	});
}

/* ---------- 启动 ---------- */

async function boot() {
	if (!pideck || typeof pideck.context.get !== "function") {
		document.body.textContent = "This page must run inside a PiDeck panel.";
		return;
	}
	bindNewGroup();
	bindModal();
	bindToggleAll();
	bindSearch();
	bindInfoModal();
	const ctx = await pideck.context.get();
	state.ready = false;
	await applyContext(ctx, true);
	state.ready = true;
	pideck.onEvent(handleEvent);
	// 活跃绿点的阈值衰减：无事件时每分钟静默重绘一次；
	// 有正在进行的交互（建组/改名/删除确认/弹层）时不打扰，避免重输
	setInterval(() => {
		if (state.projectId && !pendingNew && !pendingRenameId && !pendingDeleteId && !modal.open) render();
	}, 60_000);
}

boot().catch((err) => {
	setStatus(String((err && err.message) || err), true);
});
