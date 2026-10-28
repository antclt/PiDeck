// 会话分组 / Session Groups — PiDeck 宿主插件（v2，工作区级）
// 只用 window.pideck 能力面：context / sessions / storage / workbench / onEvent。
// 会话数据只读；分组关系存插件私有 storage，范围是整个工作区（storage 单键 ≤64KB，所以分组与 id 列表分键存）。
"use strict";

const pideck = window.pideck;

/* ---------- 文案（中英两套，跟随 context.locale） ---------- */

const STR = {
	"zh-CN": {
		title: "会话分组",
		workspace: "全部项目",
		statsSep: " · ",
		sessionsUnit: "个会话",
		dirsUnit: "个目录",
		groupsUnit: "个分组",
		newGroup: "新建分组",
		createGroup: "新建分组",
		groupNamePlaceholder: "分组名称，如「T6 结账流程」",
		createDirsHead: "按目录添加（可选）",
		createDirsHint: "选中目录里的所有会话会加入本组；目录里以后新增的会话不会自动加入。",
		createHint: "将加入 {n} 个会话（含已在其他分组的）",
		createHintEmpty: "也可以先建空分组，稍后手动添加会话",
		scopeLabel: "目录范围",
		scopeAll: "全部目录",
		scopeHint: "本组只收这些目录里的会话；勾别的目录的会话会让该目录自动并入范围。",
		editScope: "编辑目录范围",
		editScopeTitle: "编辑「{name}」的目录范围",
		editScopeHint: "收窄范围会移出不在范围内的会话（会话本身不删）。",
		onlyScope: "只看范围",
		showAllDirs: "显示全部目录",
		fillScope: "按目录补齐",
		fillScopeHint: "把范围目录里还没进来的会话全部加进来",
		filled: "已按目录补齐 {n} 个会话",
		fillEmpty: "范围目录里没有新的会话",
		fillNeedScope: "先编辑目录范围：不限目录时不能按目录补齐",
		pruned: "已按目录范围移出 {n} 个会话",
		extendScope: "已把目录「{dir}」并入本组范围",
		selectAll: "全选",
		clearAll: "清空",
		ungrouped: "未分组",
		addSessions: "添加会话",
		addSessionsTitle: "添加会话到「{name}」",
		rename: "重命名",
		deleteGroup: "删除分组",
		removeSession: "移出分组",
		confirmDelete: "删除分组「{name}」？只删分组，不会删会话；它们在别的分组里的引用也不受影响。",
		delete: "删除",
		cancel: "取消",
		save: "保存",
		create: "创建",
		searchPlaceholder: "搜索会话标题…",
		filterDir: "全部目录",
		empty: "还没有分组",
		emptyHint: "点右上角「新建分组」，可以直接选目录把整个目录的会话收进来。",
		emptyGroup: "空分组，点「添加会话」放会话进来。",
		noSessions: "工作区还没有已保存的会话。",
		noMatch: "没有匹配的会话",
		justNow: "刚刚",
		minAgo: " 分钟前",
		hourAgo: " 小时前",
		dayAgo: " 天前",
		loadError: "加载会话目录失败：",
		actionError: "操作失败：",
		modalHint: "勾选只加/减本组，会话可以同时在多个分组里",
		untitled: "（无标题）",
		activeNow: "活跃中",
		currentTag: "当前",
		detailTitle: "会话详情",
		fieldDirectory: "所属目录",
		fieldProject: "项目",
		fieldBackend: "后端",
		fieldModel: "模型",
		fieldGroups: "所属分组",
		fieldCreatedAt: "创建时间",
		fieldUpdatedAt: "更新时间",
		fieldStatus: "状态",
		fieldId: "会话 ID",
		statusSaved: "已保存 · 可读历史",
		statusNoHistory: "已保存 · 无历史文件（直接打开即可）",
		unreadableTag: "无历史",
		noGroup: "未加入任何分组",
		expandAll: "全部展开",
		collapseAll: "全部收起",
		clearSearch: "清空搜索",
		select: "选择",
		selectedUnit: "已选 {n}",
		removeSelected: "移出本组",
		done: "完成",
		showMore: "显示更多（还有 {n} 个）",
		changeColor: "换颜色",
		moveUp: "上移",
		moveDown: "下移",
		collapse: "收起",
		expand: "展开",
		unknownDir: "未知目录",
		allProjectsHint: "跨项目会话可同组，点击自动切换项目",
	},
	"en-US": {
		title: "Session groups",
		workspace: "All projects",
		statsSep: " · ",
		sessionsUnit: "sessions",
		dirsUnit: "directories",
		groupsUnit: "groups",
		newGroup: "New group",
		createGroup: "New group",
		groupNamePlaceholder: "Group name, e.g. “T6 checkout flow”",
		createDirsHead: "Add by directory (optional)",
		createDirsHint: "Every session in the checked directories joins this group; sessions added to a directory later do not join automatically.",
		createHint: "{n} sessions will join (including ones already in other groups)",
		createHintEmpty: "You can also create an empty group and add sessions later",
		scopeLabel: "Directories",
		scopeAll: "All directories",
		scopeHint: "This group only takes sessions from these directories; ticking a session elsewhere adds that directory to the scope.",
		editScope: "Edit directories",
		editScopeTitle: "Edit directories of “{name}”",
		editScopeHint: "Narrowing the scope removes sessions outside it (sessions are not deleted).",
		onlyScope: "Scope only",
		showAllDirs: "Show all directories",
		fillScope: "Fill from directories",
		fillScopeHint: "Add every session in the scoped directories that is not here yet",
		filled: "Filled {n} sessions from directories",
		fillEmpty: "No new sessions in the scoped directories",
		fillNeedScope: "Edit the directories first: fill needs a directory scope",
		pruned: "Removed {n} sessions outside the directory scope",
		extendScope: "Added directory “{dir}” to the group scope",
		selectAll: "All",
		clearAll: "None",
		ungrouped: "Ungrouped",
		addSessions: "Add sessions",
		addSessionsTitle: "Add sessions to “{name}”",
		rename: "Rename",
		deleteGroup: "Delete group",
		removeSession: "Remove from group",
		confirmDelete: "Delete group \"{name}\"? Sessions are not deleted; other groups keep their references.",
		delete: "Delete",
		cancel: "Cancel",
		save: "Save",
		create: "Create",
		searchPlaceholder: "Search session titles…",
		filterDir: "All directories",
		empty: "No groups yet",
		emptyHint: "Click “New group” and pick directories to pull a whole directory's sessions in at once.",
		emptyGroup: "Empty group. Use “Add sessions” to fill it.",
		noSessions: "No saved sessions in this workspace yet.",
		noMatch: "No matching sessions",
		justNow: "just now",
		minAgo: " min ago",
		hourAgo: " h ago",
		dayAgo: " d ago",
		loadError: "Failed to load session catalog: ",
		actionError: "Action failed: ",
		modalHint: "Checking only adds/removes this group; a session can live in several groups",
		untitled: "(untitled)",
		activeNow: "Active",
		currentTag: "Current",
		detailTitle: "Session details",
		fieldDirectory: "Directory",
		fieldProject: "Project",
		fieldBackend: "Backend",
		fieldModel: "Model",
		fieldGroups: "Groups",
		fieldCreatedAt: "Created",
		fieldUpdatedAt: "Updated",
		fieldStatus: "Status",
		fieldId: "Session ID",
		statusSaved: "Saved · history readable",
		statusNoHistory: "Saved · no history file (opens directly)",
		unreadableTag: "No history",
		noGroup: "Not in any group",
		expandAll: "Expand all",
		collapseAll: "Collapse all",
		clearSearch: "Clear search",
		select: "Select",
		selectedUnit: "{n} selected",
		removeSelected: "Remove from group",
		done: "Done",
		showMore: "Show more ({n} left)",
		changeColor: "Change color",
		moveUp: "Move up",
		moveDown: "Move down",
		collapse: "Collapse",
		expand: "Expand",
		unknownDir: "Unknown directory",
		allProjectsHint: "Sessions from different projects can share a group; clicking switches project",
	},
};

let L = STR["zh-CN"];

/* ---------- 常量 ---------- */

const META_KEY = "ws.meta";
const GROUP_PREFIX = "ws.g.";
const LEGACY_PREFIX = "grp.";
const UNGROUPED = "__ungrouped__";
const COLORS = ["blue", "green", "orange", "purple", "red", "cyan"];
const PAGE_SIZE = 100; // 与宿主 sessions.list 的页大小一致
const UNGROUPED_PAGE = 60;
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const COLOR_INDEX = new Map(COLORS.map((name, index) => [name, index]));
// 单键 JSON 上限 64KB：一个分组装几千条 id 会超，超出部分拆到 `ws.g.<id>.<n>` 分片键。
const GROUP_CHUNK = 800;
const chunkKey = (groupId, index) => `${GROUP_PREFIX}${groupId}.${index}`;

/* ---------- 状态 ---------- */

const state = {
	projectId: undefined,
	projectName: undefined,
	currentSessionId: undefined,
	scope: "project",
	locale: "zh-CN",
	sessions: new Map(), // id -> HostPluginSession
	groups: [], // { id, name, color, createdAt, ids: [], dirs: [] }：数组顺序即显示顺序；dirs 为空数组 = 不限目录（旧分组默认）
	collapsed: new Set(),
	ready: false,
};

// 瞬时 UI 状态（不持久化）
let filterQuery = "";
let dirFilter = "";
let draggingId = null;
let ungroupedVisible = UNGROUPED_PAGE;
const selection = { groupId: null, ids: new Set() };
const modal = { groupId: null, was: new Set(), now: new Set(), dirs: new Set(), allDirs: false };
const createDraft = { dirs: new Set(), mode: "create", groupId: null };

/* ---------- 工具 ---------- */

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = text;
	return node;
}

function iconBtn(text, title, cls) {
	const node = el("button", "icon-btn" + (cls ? " " + cls : ""), text);
	node.type = "button";
	node.title = title;
	node.setAttribute("aria-label", title);
	return node;
}

function newGroupId() {
	return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function timeOf(value) {
	const t = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(t) ? t : NaN;
}

function isRecentlyActive(session) {
	const t = timeOf(session.updatedAt);
	return Number.isFinite(t) && Date.now() - t <= ACTIVE_WINDOW_MS;
}

// 把宿主下发的主题 token（--color-*）写到 <html> 内联样式上。
// 不能只依赖宿主的 insertCSS 注入：在 webview 完成导航前插入容易丢失，
// 面板就只剩 CSS 缺省色；内联变量优先级最高且随 context.changed 实时刷新。
function applyTokens(tokens) {
	const style = document.documentElement.style;
	if (!tokens || typeof tokens !== "object") return;
	for (const [name, value] of Object.entries(tokens)) {
		if (typeof name !== "string" || typeof value !== "string" || !value) continue;
		style.setProperty(name.startsWith("--") ? name : "--" + name, value);
	}
}

function fmtTime(ts) {
	const t = timeOf(ts);
	if (!Number.isFinite(t)) return "";
	const diff = Date.now() - t;
	if (diff < 60_000) return L.justNow;
	if (diff < 3_600_000) return Math.floor(diff / 60_000) + L.minAgo;
	if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + L.hourAgo;
	return Math.floor(diff / 86_400_000) + L.dayAgo;
}

/** 完整时间（到分钟）：分组页里「什么时候聊的」比「几天前」更有用。 */
function fmtClock(ts) {
	const d = new Date(timeOf(ts));
	if (Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function fmtDate(ts) {
	const d = new Date(timeOf(ts));
	if (Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/** 目录路径中间省略：`D:\project\java\T6` → `D:\…\java\T6`，够区分又不占满一行。 */
function shortPath(path) {
	if (!path) return "";
	const parts = String(path).split(/[\\/]+/).filter(Boolean);
	if (parts.length <= 3) return path;
	const drive = /^[a-zA-Z]:$/.test(parts[0]) ? parts[0] : "";
	const tail = parts.slice(-2);
	return drive ? drive + "\\…\\" + tail.join("\\") : "…/" + tail.join("/");
}

let statusTimer = null;
function setStatus(msg, isError) {
	const node = $("status");
	if (!node) return;
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

function debounce(fn, ms) {
	let timer = null;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/* ---------- 存储（分键 + 串行写） ---------- */

// 宿主 storage 单键 JSON 上限 64KB，且同一时刻只允许 2 个并发请求：
// 所有读写都串行排队，避免 rate-limited 与互相覆盖。
let ioChain = Promise.resolve();
function queue(fn) {
	ioChain = ioChain.then(fn).catch((err) => actionError(err));
	return ioChain;
}

function normalizeIds(value) {
	return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && id))] : [];
}

function saveMeta() {
	return queue(() =>
		pideck.storage.set(META_KEY, {
			v: 2,
			groups: state.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, createdAt: g.createdAt, dirs: groupScope(g) })),
			collapsed: [...state.collapsed],
		}),
	);
}

function saveGroup(group) {
	return queue(async () => {
		const chunks = [];
		for (let index = 0; index < group.ids.length; index += GROUP_CHUNK) chunks.push(group.ids.slice(index, index + GROUP_CHUNK));
		const previous = group.chunks ?? 0;
		if (chunks.length <= 1) {
			await pideck.storage.set(GROUP_PREFIX + group.id, { ids: group.ids });
		} else {
			await pideck.storage.set(GROUP_PREFIX + group.id, { chunked: chunks.length });
			for (let index = 0; index < chunks.length; index += 1) await pideck.storage.set(chunkKey(group.id, index), { ids: chunks[index] });
		}
		// 组缩小后旧分片要清掉，否则下次读会拼出已经不存在的 id
		const kept = chunks.length <= 1 ? 0 : chunks.length;
		for (let index = kept; index < previous; index += 1) await pideck.storage.remove(chunkKey(group.id, index)).catch(() => {});
		group.chunks = kept;
	});
}

/** 旧版按键（grp.<projectId>）一次性并入工作区数据；旧键保留不删，用户回退版本也不会丢。 */
async function migrateLegacy() {
	let keys = [];
	try {
		keys = await pideck.storage.keys();
	} catch {
		keys = [];
	}
	const legacyKeys = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && key.startsWith(LEGACY_PREFIX));
	if (legacyKeys.length === 0) return false;
	const byId = new Map(state.groups.map((g) => [g.id, g]));
	let merged = false;
	for (const key of legacyKeys) {
		let raw;
		try {
			raw = await pideck.storage.get(key);
		} catch {
			continue;
		}
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.groups)) continue;
		for (const item of raw.groups) {
			if (!item || typeof item.id !== "string" || typeof item.name !== "string") continue;
			const ids = normalizeIds(item.sessionIds);
			const existing = byId.get(item.id);
			if (existing) {
				for (const id of ids) if (!existing.ids.includes(id)) existing.ids.push(id);
			} else {
				const group = {
					id: item.id,
					name: item.name,
					color: COLORS[state.groups.length % COLORS.length],
					createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
					ids,
				};
				state.groups.push(group);
				byId.set(group.id, group);
			}
			merged = true;
		}
		if (Array.isArray(raw.collapsed)) for (const id of raw.collapsed) if (typeof id === "string") state.collapsed.add(id);
	}
	if (!merged) return false;
	for (const group of state.groups) await saveGroup(group);
	await saveMeta();
	return true;
}

async function loadWorkspaceData() {
	state.groups = [];
	state.collapsed = new Set();
	let meta;
	try {
		meta = await pideck.storage.get(META_KEY);
	} catch {
		meta = undefined;
	}
	if (meta && typeof meta === "object" && Array.isArray(meta.groups)) {
		for (const item of meta.groups) {
			if (!item || typeof item.id !== "string" || typeof item.name !== "string") continue;
			state.groups.push({
				id: item.id,
				name: item.name,
				color: COLORS.includes(item.color) ? item.color : COLORS[state.groups.length % COLORS.length],
				createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
				dirs: Array.isArray(item.dirs) ? item.dirs.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 240).slice(0, 64) : [],
				ids: [],
			});
		}
		if (Array.isArray(meta.collapsed)) for (const id of meta.collapsed) if (typeof id === "string") state.collapsed.add(id);
	}
	for (const group of state.groups) {
		try {
			const raw = await pideck.storage.get(GROUP_PREFIX + group.id);
			if (!raw || typeof raw !== "object") continue;
			if (Array.isArray(raw.ids)) {
				group.ids = normalizeIds(raw.ids);
				continue;
			}
			const chunked = Number.isInteger(raw.chunked) ? raw.chunked : 0;
			if (chunked <= 0) continue;
			const ids = [];
			for (let index = 0; index < chunked; index += 1) {
				const part = await pideck.storage.get(chunkKey(group.id, index));
				if (part && Array.isArray(part.ids)) ids.push(...part.ids);
			}
			group.ids = normalizeIds(ids);
			group.chunks = chunked;
		} catch {
			group.ids = [];
		}
	}
	const migrated = await migrateLegacy();
	if (!meta || migrated) await saveMeta();
}

/* ---------- 会话目录 ---------- */

/** 分页拉全工作区会话目录（每页 100；nextOffset 不前进就停，防死循环）。 */
async function loadCatalog() {
	const map = new Map();
	let offset = 0;
	let guard = 0;
	while (guard++ < 5000) {
		const page = await pideck.sessions.list(offset);
		for (const session of page.sessions || []) map.set(session.id, session);
		if (page.nextOffset == null || page.nextOffset === offset) break;
		offset = page.nextOffset;
	}
	state.sessions = map;
}

/** 会话被删/替代后清掉失效引用；分组/折叠集合随之收敛（只写有变化的部分）。 */
function pruneState() {
	let changed = false;
	for (const group of state.groups) {
		const before = group.ids.length;
		group.ids = group.ids.filter((id) => state.sessions.has(id));
		if (group.ids.length !== before) {
			changed = true;
			void saveGroup(group);
		}
	}
	const valid = new Set([UNGROUPED, ...state.groups.map((group) => group.id)]);
	for (const id of [...state.collapsed]) {
		if (!valid.has(id)) {
			state.collapsed.delete(id);
			changed = true;
		}
	}
	if (changed) void saveMeta();
	return changed;
}

async function reloadCatalog() {
	try {
		await loadCatalog();
		pruneState();
		render();
	} catch (err) {
		setStatus(L.loadError + (err && err.message ? err.message : ""), true);
	}
}

const scheduleReload = debounce(() => void reloadCatalog(), 600);

/* ---------- 数据模型 ---------- */

function groupById(id) {
	return state.groups.find((group) => group.id === id) ?? null;
}

function groupsOf(sessionId) {
	return state.groups.filter((group) => group.ids.includes(sessionId));
}

function ungroupedIds() {
	const grouped = new Set();
	for (const group of state.groups) for (const id of group.ids) grouped.add(id);
	return [...state.sessions.keys()].filter((id) => !grouped.has(id));
}

function addToGroup(group, sessionId) {
	if (!group || group.ids.includes(sessionId)) return false;
	group.ids.push(sessionId);
	// 拖进/手工加进来的会话可能不属于现有目录范围：连带把目录并入，避免组内容与范围不一致。
	const session = state.sessions.get(sessionId);
	if (session && extendScope(group, session)) {
		void saveMeta();
		setStatus(L.extendScope.replace("{dir}", scopeLabelOf(dirKeyOf(session))));
	}
	void saveGroup(group);
	return true;
}

function removeFromGroup(group, sessionId) {
	const before = group.ids.length;
	group.ids = group.ids.filter((id) => id !== sessionId);
	if (group.ids.length === before) return false;
	void saveGroup(group);
	return true;
}

function removeFromAll(sessionId) {
	let changed = false;
	for (const group of state.groups) if (removeFromGroup(group, sessionId)) changed = true;
	return changed;
}

/** 会话的目录身份：优先宿主给的目录，退化到项目名（旧目录里没有 directory 字段）。 */
function dirKeyOf(session) {
	if (!session) return "unknown";
	if (session.directory) return session.directory;
	if (session.projectName) return "name:" + session.projectName;
	if (session.projectId) return "project:" + session.projectId;
	return "unknown";
}

function dirLabelOf(key, sample) {
	if (key === "unknown") return L.unknownDir;
	if (key.startsWith("name:")) return key.slice(5);
	if (key.startsWith("project:")) return L.unknownDir;
	return (sample && sample.projectName) || key;
}

/** 目录范围：空数组 = 不限（旧分组与「先建空分组」都走这里）。 */
function groupScope(group) {
	return Array.isArray(group.dirs) ? group.dirs.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 240).slice(0, 64) : [];
}

/** 会话是否落在分组目录范围内（不限目录时恒为 true）。 */
function inScope(group, session) {
	const scope = groupScope(group);
	return scope.length === 0 || scope.includes(dirKeyOf(session));
}

/** 把会话所在目录并入范围：手工放进来的会话不能让组处于「范围外」的不一致状态。 */
function extendScope(group, session) {
	const key = dirKeyOf(session);
	const scope = groupScope(group);
	if (scope.length === 0 || scope.includes(key)) return false;
	group.dirs = [...scope, key];
	return true;
}

/** 按目录补齐全部分组的范围目录（不动其他分组）。 */
async function fillGroupFromDirs(group) {
	const scope = groupScope(group);
	if (scope.length === 0) {
		setStatus(L.fillNeedScope);
		return;
	}
	const before = group.ids.length;
	for (const entry of dirEntries()) {
		if (!scope.includes(entry.key)) continue;
		for (const id of entry.ids) if (!group.ids.includes(id)) group.ids.push(id);
	}
	const added = group.ids.length - before;
	if (added === 0) {
		setStatus(L.fillEmpty);
		return;
	}
	group.ids = sortByUpdated(group.ids);
	await saveGroup(group);
	setStatus(L.filled.replace("{n}", String(added)));
	render();
}

function scopeLabelOf(key) {
	if (key === "unknown") return L.unknownDir;
	if (key.startsWith("name:")) return key.slice(5);
	if (key.startsWith("project:")) return L.unknownDir;
	return shortPath(key) || key;
}

/** 目录分节：按会话数降序，用来做「按目录添加」和行上的归属说明。 */
function dirEntries(ids) {
	const map = new Map();
	const source = ids ? ids.map((id) => state.sessions.get(id)).filter(Boolean) : [...state.sessions.values()];
	for (const session of source) {
		const key = dirKeyOf(session);
		let entry = map.get(key);
		if (!entry) {
			entry = { key, label: dirLabelOf(key, session), short: shortPath(session.directory) || dirLabelOf(key, session), directory: session.directory || "", projectName: session.projectName, ids: [] };
			map.set(key, entry);
		}
		entry.ids.push(session.id);
	}
	// 同名项目靠路径区分：显示用短路径，完整路径放 title
	return [...map.values()].sort((a, b) => b.ids.length - a.ids.length || a.short.localeCompare(b.short));
}

function matchesFilters(session) {
	if (!session) return false;
	if (dirFilter && dirKeyOf(session) !== dirFilter) return false;
	if (!filterQuery) return true;
	return (session.title || "").toLowerCase().includes(filterQuery);
}

function sortByUpdated(ids) {
	return [...ids].sort((a, b) => {
		const sa = state.sessions.get(a);
		const sb = state.sessions.get(b);
		const ta = timeOf(sa && sa.updatedAt);
		const tb = timeOf(sb && sb.updatedAt);
		if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
		return String(a).localeCompare(String(b));
	});
}

function visibleIds(ids) {
	return sortByUpdated(ids.filter((id) => matchesFilters(state.sessions.get(id))));
}

/* ---------- 上下文 / 事件 ---------- */

async function applyContext(context) {
	const previousLocale = state.locale;
	const previousProjectId = state.projectId;
	state.projectId = context.projectId;
	state.projectName = context.projectName;
	state.currentSessionId = context.sessionId;
	state.scope = context.scope === "workspace" ? "workspace" : "project";
	state.locale = context.locale === "en-US" ? "en-US" : "zh-CN";
	L = STR[state.locale];
	// 把主题写到 <html data-theme>，CSS 据此联动错误色/遮罩等 --color-* 没覆盖的语义色
	document.documentElement.dataset.theme = context.theme === "light" ? "light" : "dark";
	applyTokens(context.tokens);
	if (!state.ready) {
		await loadWorkspaceData();
		await reloadCatalog();
	} else if (state.scope !== "workspace" && previousProjectId !== state.projectId) {
		// 没拿到工作区范围时退回旧行为：切项目重载（分组数据同一份，不会被覆盖）
		await reloadCatalog();
	} else if (previousLocale !== state.locale) {
		// 只换文案：分组没有语言相关的持久化字段，不需要重读数据
	}
	render();
}

function handleEvent(event) {
	if (!event || !event.type) return;
	if (event.type === "context.changed") {
		void applyContext(event.context || {}).catch(actionError);
		return;
	}
	if (event.type !== "sessions.changed") return;
	const detail = event.detail || {};
	if (detail.catalogChanged) {
		scheduleReload();
		return;
	}
	if (!detail.sessionId) return;
	// 单条变化（改名/更新/删除）：就地刷新，不必重拉整张目录
	const id = detail.sessionId;
	void pideck.sessions
		.get(id)
		.then((session) => {
			if (session) state.sessions.set(session.id, session);
			else state.sessions.delete(id);
			render();
		})
		.catch(() => scheduleReload());
}

/* ---------- 渲染：静态文本 ---------- */

function renderStaticText() {
	document.documentElement.lang = state.locale;
	$("scope-title").textContent = L.title;
	$("btn-new").textContent = L.newGroup;
	$("btn-toggle-all").textContent = anyCollapsed() ? L.expandAll : L.collapseAll;
	$("search-input").placeholder = L.searchPlaceholder;
	$("search-clear").title = L.clearSearch;
	$("create-title").textContent = createDraft.mode === "edit" ? L.editScopeTitle.replace("{name}", $("create-name").value || L.scopeLabel) : L.createGroup;
	$("create-name").placeholder = L.groupNamePlaceholder;
	$("create-dirs-head").textContent = createDraft.mode === "edit" ? L.scopeLabel : L.createDirsHead;
	$("create-dirs-all").textContent = L.selectAll;
	$("create-dirs-none").textContent = L.clearAll;
	$("create-note").hidden = createDraft.mode !== "edit";
	$("create-note").textContent = createDraft.mode === "edit" ? L.editScopeHint : "";
	$("create-cancel").textContent = L.cancel;
	$("create-ok").textContent = createDraft.mode === "edit" ? L.save : L.create;
	$("modal-search").placeholder = L.searchPlaceholder;
	$("modal-cancel").textContent = L.cancel;
	$("modal-save").textContent = L.save;
	$("info-close").title = L.cancel;
	$("dir-filter").title = L.filterDir;
}

function renderStats() {
	const dirs = dirEntries().length;
	$("scope-stats").textContent = [state.scope === "workspace" ? L.workspace : state.projectName || L.workspace, `${state.sessions.size} ${L.sessionsUnit}`, `${dirs} ${L.dirsUnit}`, `${state.groups.length} ${L.groupsUnit}`].join(L.statsSep);
}

/* ---------- 渲染：会话行 ---------- */

function backendBadge(session) {
	if (!session || !session.backend) return null;
	const map = {
		pi: ["pi", "pi"],
		dsh: ["DSH", "dsh"],
		acp: ["ACP", "acp"],
		imagegen: ["IMG", "img"],
		videogen: ["VID", "vid"],
	};
	const pair = map[session.backend];
	if (!pair) return null;
	const badge = el("span", "badge badge-" + pair[1], pair[0]);
	badge.title = session.backend;
	return badge;
}

function sessionRow(sessionId, groupId) {
	const session = state.sessions.get(sessionId);
	if (!session) return null;
	const inSelection = selection.groupId != null && selection.groupId === groupId;
	const checked = inSelection && selection.ids.has(sessionId);
	const row = el("div", "session" + (sessionId === state.currentSessionId ? " current" : "") + (checked ? " selected" : ""));
	row.dataset.sessionId = sessionId;

	if (inSelection) {
		const box = el("input", "session-check");
		box.type = "checkbox";
		box.checked = checked;
		box.addEventListener("click", (event) => event.stopPropagation());
		box.addEventListener("change", () => {
			if (box.checked) selection.ids.add(sessionId);
			else selection.ids.delete(sessionId);
			render();
		});
		row.append(box);
	}

	const main = el("div", "session-main");
	const line1 = el("div", "session-line");
	if (isRecentlyActive(session)) {
		const dot = el("span", "active-dot");
		dot.title = L.activeNow;
		line1.append(dot);
	}
	const title = el("span", "session-title", session.title || L.untitled);
	title.title = session.title || L.untitled;
	line1.append(title);
	if (sessionId === state.currentSessionId) line1.append(el("span", "tag current-tag", L.currentTag));
	if (session.backend && session.backend !== "pi") line1.append(el("span", "tag soft-tag", session.backend));
	line1.append(el("span", "session-clock", fmtClock(session.updatedAt)));
	main.append(line1);

	const line2 = el("div", "session-line session-line-2");
	const badge = backendBadge(session);
	if (badge) line2.append(badge);
	if (session.model) line2.append(el("span", "model", session.model));
	const dirText = session.directory || session.projectName || L.unknownDir;
	const path = el("span", "dir-path", shortPath(dirText));
	path.title = dirText;
	line2.append(path);
	line2.append(el("span", "session-rel", fmtTime(session.updatedAt)));
	main.append(line2);

	main.addEventListener("click", () => {
		if (inSelection) {
			if (selection.ids.has(sessionId)) selection.ids.delete(sessionId);
			else selection.ids.add(sessionId);
			render();
			return;
		}
		void pideck.workbench.navigate(sessionId).catch(actionError);
	});
	row.append(main);

	const tools = el("div", "session-tools");
	const info = iconBtn("ⓘ", L.detailTitle, "session-info");
	info.addEventListener("click", (event) => {
		event.stopPropagation();
		openInfoModal(sessionId);
	});
	tools.append(info);
	if (groupId) {
		const remove = iconBtn("×", L.removeSession, "session-remove");
		remove.addEventListener("click", (event) => {
			event.stopPropagation();
			const group = groupById(groupId);
			if (group && removeFromGroup(group, sessionId)) render();
		});
		tools.append(remove);
	}
	row.append(tools);

	row.draggable = true;
	row.addEventListener("dragstart", (event) => {
		draggingId = sessionId;
		if (event.dataTransfer) {
			event.dataTransfer.setData("text/plain", sessionId);
			event.dataTransfer.effectAllowed = "move";
		}
		row.classList.add("dragging");
	});
	row.addEventListener("dragend", () => {
		draggingId = null;
		row.classList.remove("dragging");
	});
	return row;
}

/* ---------- 渲染：分组卡片 ---------- */

function nextColor(color) {
	const index = COLOR_INDEX.has(color) ? COLOR_INDEX.get(color) : -1;
	return COLORS[(index + 1) % COLORS.length];
}

function selectionBar(group) {
	const bar = el("div", "select-bar");
	const count = el("span", "select-count", L.selectedUnit.replace("{n}", String(selection.ids.size)));
	bar.append(count);
	const all = el("button", "link-btn", L.selectAll);
	all.type = "button";
	all.addEventListener("click", () => {
		for (const id of visibleIds(group.ids)) selection.ids.add(id);
		render();
	});
	const none = el("button", "link-btn", L.clearAll);
	none.type = "button";
	none.addEventListener("click", () => {
		selection.ids.clear();
		render();
	});
	const remove = el("button", "link-btn danger", L.removeSelected);
	remove.type = "button";
	remove.disabled = selection.ids.size === 0;
	remove.addEventListener("click", () => {
		for (const id of selection.ids) removeFromGroup(group, id);
		selection.groupId = null;
		selection.ids.clear();
		render();
	});
	const done = el("button", "link-btn", L.done);
	done.type = "button";
	done.addEventListener("click", () => {
		selection.groupId = null;
		selection.ids.clear();
		render();
	});
	bar.append(all, none, remove, done);
	return bar;
}

function attachDropTarget(node, onDrop) {
	node.addEventListener("dragover", (event) => {
		if (!draggingId) return;
		event.preventDefault();
		node.classList.add("drop-hover");
	});
	node.addEventListener("dragleave", () => node.classList.remove("drop-hover"));
	node.addEventListener("drop", (event) => {
		event.preventDefault();
		node.classList.remove("drop-hover");
		const sessionId = draggingId || (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
		draggingId = null;
		if (sessionId && state.sessions.has(sessionId)) onDrop(sessionId);
	});
}

/** 删除分组：只清分组与它的分片键，会话本身与别的分组不受影响。 */
function deleteGroup(group) {
	const chunks = group.chunks ?? 0;
	state.groups = state.groups.filter((item) => item.id !== group.id);
	state.collapsed.delete(group.id);
	if (selection.groupId === group.id) {
		selection.groupId = null;
		selection.ids.clear();
	}
	void queue(async () => {
		await pideck.storage.remove(GROUP_PREFIX + group.id).catch(() => {});
		for (let index = 0; index < chunks; index += 1) await pideck.storage.remove(chunkKey(group.id, index)).catch(() => {});
	});
	void saveMeta();
	render();
}

function groupCard(group, index, forceExpand) {
	const collapsed = !forceExpand && state.collapsed.has(group.id);
	const card = el("section", "group" + (collapsed ? " collapsed" : ""));
	card.dataset.groupId = group.id;

	const head = el("div", "group-head");
	const dot = el("button", "color-dot color-" + group.color);
	dot.type = "button";
	dot.title = L.changeColor;
	dot.addEventListener("click", () => {
		group.color = nextColor(group.color);
		void saveMeta();
		render();
	});
	head.append(dot);

	const nameWrap = el("div", "group-name-wrap");
	nameWrap.append(el("span", "group-name", group.name));
	const dirs = new Set(group.ids.map((id) => dirKeyOf(state.sessions.get(id))));
	nameWrap.append(el("span", "group-meta", `${group.ids.length} ${L.sessionsUnit}${L.statsSep}${dirs.size} ${L.dirsUnit}`));
	const scope = groupScope(group);
	const scopeBox = el("span", "group-scope");
	if (scope.length === 0) {
		scopeBox.append(el("span", "scope-chip muted", L.scopeAll));
	} else {
		for (const key of scope.slice(0, 2)) scopeBox.append(el("span", "scope-chip", scopeLabelOf(key)));
		if (scope.length > 2) scopeBox.append(el("span", "scope-chip", `+${scope.length - 2}`));
	}
	scopeBox.title = scope.length === 0 ? L.scopeHint : `${L.scopeLabel}: ${scope.join("\n")}`;
	nameWrap.append(scopeBox);
	head.append(nameWrap);

	const tools = el("div", "group-tools");
	const up = iconBtn("↑", L.moveUp);
	up.disabled = index === 0;
	up.addEventListener("click", () => {
		state.groups.splice(index, 1);
		state.groups.splice(index - 1, 0, group);
		void saveMeta();
		render();
	});
	const down = iconBtn("↓", L.moveDown);
	down.disabled = index === state.groups.length - 1;
	down.addEventListener("click", () => {
		state.groups.splice(index, 1);
		state.groups.splice(index + 1, 0, group);
		void saveMeta();
		render();
	});
	const select = iconBtn("☑", L.select);
	select.addEventListener("click", () => {
		if (selection.groupId === group.id) {
			selection.groupId = null;
			selection.ids.clear();
		} else {
			selection.groupId = group.id;
			selection.ids = new Set();
		}
		render();
	});
	const add = iconBtn("＋", L.addSessions);
	add.addEventListener("click", () => openAddModal(group.id));
	const fill = iconBtn("⟳", L.fillScopeHint);
	fill.disabled = groupScope(group).length === 0;
	fill.addEventListener("click", () => {
		void fillGroupFromDirs(group);
	});
	const scopeBtn = iconBtn("📁", L.editScope);
	scopeBtn.addEventListener("click", () => openScopeEditor(group.id));
	const rename = iconBtn("✎", L.rename);
	rename.addEventListener("click", () => {
		// 不用 window.prompt：Electron 的渲染器不支持 prompt，改名走行内输入。
		const input = el("input", "text-input group-rename");
		input.type = "text";
		input.value = group.name;
		input.maxLength = 80;
		input.setAttribute("aria-label", L.rename);
		nameWrap.replaceChildren(input);
		input.focus();
		input.select();
		let settled = false;
		const finish = (commit) => {
			if (settled) return;
			settled = true;
			const next = input.value.trim();
			if (commit && next && next !== group.name) {
				group.name = next.slice(0, 80);
				void saveMeta();
			}
			render();
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(true));
	});
	const remove = iconBtn("✕", L.deleteGroup);
	remove.addEventListener("click", () => {
		// 同样不用 window.confirm：就地换成确认条，不阻塞也不依赖渲染器对话框。
		const bar = el("div", "confirm-bar");
		bar.append(el("span", "confirm-text", L.confirmDelete.replace("{name}", group.name)));
		const yes = el("button", "link-btn danger", L.delete);
		yes.type = "button";
		yes.addEventListener("click", () => deleteGroup(group));
		const no = el("button", "link-btn", L.cancel);
		no.type = "button";
		no.addEventListener("click", () => render());
		bar.append(yes, no);
		tools.replaceChildren(bar);
	});
	const toggle = iconBtn(collapsed ? "▸" : "▾", collapsed ? L.expand : L.collapse);
	toggle.addEventListener("click", () => {
		if (collapsed) state.collapsed.delete(group.id);
		else state.collapsed.add(group.id);
		void saveMeta();
		render();
	});
	tools.append(up, down, select, fill, add, scopeBtn, rename, remove, toggle);
	head.append(tools);
	head.addEventListener("dblclick", () => {
		if (collapsed) state.collapsed.delete(group.id);
		else state.collapsed.add(group.id);
		void saveMeta();
		render();
	});
	card.append(head);

	attachDropTarget(card, (sessionId) => {
		if (addToGroup(group, sessionId)) render();
	});

	if (collapsed) return card;

	const body = el("div", "group-body");
	if (selection.groupId === group.id) body.append(selectionBar(group));
	const ids = visibleIds(group.ids);
	if (ids.length === 0) body.append(el("p", "empty", L.emptyGroup));
	for (const id of ids) {
		const row = sessionRow(id, group.id);
		if (row) body.append(row);
	}
	card.append(body);
	return card;
}

function ungroupedCard(forceExpand) {
	const collapsed = !forceExpand && state.collapsed.has(UNGROUPED);
	const card = el("section", "group ungrouped" + (collapsed ? " collapsed" : ""));
	const ids = visibleIds(ungroupedIds());

	const head = el("div", "group-head");
	head.append(el("span", "color-dot color-none"));
	const nameWrap = el("div", "group-name-wrap");
	nameWrap.append(el("span", "group-name", L.ungrouped));
	const dirs = new Set(ids.map((id) => dirKeyOf(state.sessions.get(id))));
	nameWrap.append(el("span", "group-meta", `${ids.length} ${L.sessionsUnit}${L.statsSep}${dirs.size} ${L.dirsUnit}`));
	head.append(nameWrap);
	const toggle = iconBtn(collapsed ? "▸" : "▾", collapsed ? L.expand : L.collapse);
	toggle.addEventListener("click", () => {
		if (collapsed) state.collapsed.delete(UNGROUPED);
		else state.collapsed.add(UNGROUPED);
		void saveMeta();
		render();
	});
	head.append(toggle);
	card.append(head);

	attachDropTarget(card, (sessionId) => {
		if (removeFromAll(sessionId)) render();
	});
	if (collapsed) return card;

	const body = el("div", "group-body");
	if (ids.length === 0) body.append(el("p", "empty", filterQuery || dirFilter ? L.noMatch : L.emptyGroup));
	const shown = ids.slice(0, ungroupedVisible);
	for (const id of shown) {
		const row = sessionRow(id, null);
		if (row) body.append(row);
	}
	if (ids.length > shown.length) {
		const more = el("button", "btn more", L.showMore.replace("{n}", String(ids.length - shown.length)));
		more.type = "button";
		more.addEventListener("click", () => {
			ungroupedVisible += PAGE_SIZE;
			render();
		});
		body.append(more);
	}
	card.append(body);
	return card;
}

function anyCollapsed() {
	if (state.collapsed.has(UNGROUPED)) return true;
	return state.groups.some((group) => state.collapsed.has(group.id));
}

function renderDirFilter() {
	const select = $("dir-filter");
	const entries = dirEntries();
	select.replaceChildren();
	const all = el("option", null, `${L.filterDir}（${state.sessions.size}）`);
	all.value = "";
	select.append(all);
	for (const entry of entries) {
		const option = el("option", null, `${entry.short}（${entry.ids.length}）`);
		option.value = entry.key;
		option.title = entry.directory || entry.label;
		select.append(option);
	}
	select.value = dirFilter;
	select.hidden = entries.length <= 1;
}

function render() {
	if (!state.ready) return;
	renderStaticText();
	renderStats();
	renderDirFilter();

	const container = $("groups");
	container.replaceChildren();
	if (state.sessions.size === 0) {
		container.append(el("p", "empty", L.noSessions));
		return;
	}

	if (filterQuery || dirFilter) {
		// 过滤时自动展开：结构还在，但有命中的组必须露出来（不写回 folded 状态）
		const matched = new Set(visibleIds([...state.sessions.keys()]));
		let any = false;
		state.groups.forEach((group, index) => {
			if (!group.ids.some((id) => matched.has(id))) return;
			any = true;
			container.append(groupCard(group, index, true));
		});
		if (ungroupedIds().some((id) => matched.has(id))) {
			any = true;
			container.append(ungroupedCard(true));
		}
		if (!any) container.append(el("p", "empty", L.noMatch));
		return;
	}

	if (state.groups.length === 0) {
		container.append(el("p", "empty", L.emptyHint));
	}
	state.groups.forEach((group, index) => container.append(groupCard(group, index, false)));
	container.append(ungroupedCard(false));
}

/* ---------- 新建分组弹层（按目录添加） ---------- */

function openCreateModal() {
	createDraft.mode = "create";
	createDraft.groupId = null;
	createDraft.dirs = new Set();
	$("create-name").value = "";
	renderCreateDirs();
	$("create-overlay").hidden = false;
	$("create-name").focus();
}

/** 编辑已有分组的目录范围：收窄时把范围外的会话移出（会话本身不删）。 */
function openScopeEditor(groupId) {
	const group = groupById(groupId);
	if (!group) return;
	createDraft.mode = "edit";
	createDraft.groupId = groupId;
	createDraft.dirs = new Set(groupScope(group));
	$("create-name").value = group.name;
	renderCreateDirs();
	$("create-overlay").hidden = false;
	$("create-name").focus();
}

function closeCreateModal() {
	$("create-overlay").hidden = true;
}

function createSelectedCount() {
	let count = 0;
	for (const entry of dirEntries()) if (createDraft.dirs.has(entry.key)) count += entry.ids.length;
	return count;
}

function renderCreateDirs() {
	const container = $("create-dirs");
	container.replaceChildren();
	const entries = dirEntries();
	if (entries.length === 0) {
		container.append(el("p", "empty", L.noSessions));
	} else {
		for (const entry of entries) {
			const row = el("label", "picker-row");
			const box = el("input", "picker-check");
			box.type = "checkbox";
			box.checked = createDraft.dirs.has(entry.key);
			box.addEventListener("change", () => {
				if (box.checked) createDraft.dirs.add(entry.key);
				else createDraft.dirs.delete(entry.key);
				updateCreateHint();
			});
			row.append(box);
			const text = el("div", "picker-text");
			text.append(el("span", "picker-label", entry.short));
			text.append(el("span", "picker-meta", `${entry.projectName || L.unknownDir}${L.statsSep}${entry.ids.length} ${L.sessionsUnit}`));
			row.title = entry.directory || entry.label;
			row.append(text);
			container.append(row);
		}
	}
	updateCreateHint();
}

function updateCreateHint() {
	const count = createSelectedCount();
	$("create-hint").textContent = count > 0 ? L.createHint.replace("{n}", String(count)) : L.createHintEmpty;
	$("create-ok").disabled = !$("create-name").value.trim();
	$("create-note").hidden = createDraft.mode !== "edit";
	$("create-note").textContent = createDraft.mode === "edit" ? L.editScopeHint : "";
	$("create-title").textContent = createDraft.mode === "edit" ? L.editScopeTitle.replace("{name}", $("create-name").value.trim() || L.scopeLabel) : L.createGroup;
}

async function submitCreateModal() {
	const name = $("create-name").value.trim();
	if (!name) {
		$("create-name").focus();
		return;
	}
	const scope = [...createDraft.dirs];

	if (createDraft.mode === "edit") {
		const group = groupById(createDraft.groupId);
		if (!group) {
			closeCreateModal();
			return;
		}
		group.name = name.slice(0, 80);
		group.dirs = scope;
		let removed = 0;
		if (scope.length > 0) {
			const kept = [];
			for (const id of group.ids) {
				const session = state.sessions.get(id);
				if (session && scope.includes(dirKeyOf(session))) kept.push(id);
				else removed += 1;
			}
			group.ids = kept;
		}
		await saveGroup(group);
		await saveMeta();
		closeCreateModal();
		if (removed > 0) setStatus(L.pruned.replace("{n}", String(removed)));
		render();
		return;
	}

	const group = { id: newGroupId(), name: name.slice(0, 80), color: COLORS[state.groups.length % COLORS.length], createdAt: Date.now(), ids: [], dirs: scope };
	if (scope.length > 0) {
		for (const entry of dirEntries()) {
			if (!scope.includes(entry.key)) continue;
			for (const id of entry.ids) if (!group.ids.includes(id)) group.ids.push(id);
		}
		group.ids = sortByUpdated(group.ids);
	}
	state.groups.push(group);
	await saveGroup(group);
	await saveMeta();
	ungroupedVisible = UNGROUPED_PAGE;
	closeCreateModal();
	render();
}

/* ---------- 添加会话弹层（多组归属） ---------- */

function openAddModal(groupId) {
	const group = groupById(groupId);
	if (!group) return;
	modal.groupId = groupId;
	modal.was = new Set(group.ids);
	modal.now = new Set(group.ids);
	modal.dirs = new Set(groupScope(group));
	modal.allDirs = false;
	$("modal-title").textContent = L.addSessionsTitle.replace("{name}", group.name);
	$("modal-search").value = "";
	$("modal-hint").textContent = L.modalHint;
	$("overlay").hidden = false;
	renderAddList();
	$("modal-search").focus();
}

function closeAddModal() {
	modal.groupId = null;
	modal.was = new Set();
	modal.now = new Set();
	modal.dirs = new Set();
	modal.allDirs = false;
	$("overlay").hidden = true;
}

/** 勾选不合法（跨范围）时就地把目录并入范围，保证「组内会话 ⊆ 目录范围」。 */
function addToDraft(id) {
	modal.now.add(id);
	if (modal.dirs.size === 0) return false;
	const session = state.sessions.get(id);
	if (!session) return false;
	const key = dirKeyOf(session);
	if (modal.dirs.has(key)) return false;
	modal.dirs.add(key);
	return true;
}

function renderAddList() {
	const container = $("modal-list");
	container.replaceChildren();
	const group = groupById(modal.groupId);
	if (!group) return;
	const limited = modal.dirs.size > 0;
	const showAll = !limited || modal.allDirs;

	if (limited) {
		const bar = el("div", "scope-bar");
		bar.append(el("span", "scope-bar-label", `${L.scopeLabel}${L.statsSep}`));
		for (const key of [...modal.dirs].slice(0, 4)) bar.append(el("span", "scope-chip", scopeLabelOf(key)));
		if (modal.dirs.size > 4) bar.append(el("span", "scope-chip", `+${modal.dirs.size - 4}`));
		const toggle = el("button", "link-btn", showAll ? L.onlyScope : L.showAllDirs);
		toggle.type = "button";
		toggle.addEventListener("click", () => {
			modal.allDirs = !modal.allDirs;
			renderAddList();
		});
		bar.title = L.scopeHint;
		bar.append(toggle);
		container.append(bar);
	}

	const query = $("modal-search").value.trim().toLowerCase();
	const sections = dirEntries().filter((entry) => showAll || modal.dirs.has(entry.key));
	let total = 0;
	for (const entry of sections) {
		const ids = entry.ids
			.filter((id) => {
				const session = state.sessions.get(id);
				if (!session) return false;
				if (!query) return true;
				return (session.title || "").toLowerCase().includes(query);
			})
			.sort((a, b) => {
				const ta = timeOf((state.sessions.get(a) || {}).updatedAt);
				const tb = timeOf((state.sessions.get(b) || {}).updatedAt);
				return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
			});
		if (ids.length === 0) continue;
		total += ids.length;
		const section = el("div", "picker-section");
		const head = el("div", "picker-section-head");
		const label = el("span", "picker-section-name", `${entry.short}${L.statsSep}${ids.length}`);
		if (entry.directory) label.title = entry.directory;
		head.append(label);
		const allBtn = el("button", "link-btn", L.selectAll);
		allBtn.type = "button";
		allBtn.addEventListener("click", () => {
			for (const id of ids) addToDraft(id);
			renderAddList();
		});
		const noneBtn = el("button", "link-btn", L.clearAll);
		noneBtn.type = "button";
		noneBtn.addEventListener("click", () => {
			for (const id of ids) modal.now.delete(id);
			renderAddList();
		});
		head.append(allBtn, noneBtn);
		section.append(head);

		for (const id of ids) {
			const session = state.sessions.get(id);
			if (!session) continue;
			const row = el("label", "picker-row" + (modal.now.has(id) ? " checked" : ""));
			const box = el("input", "picker-check");
			box.type = "checkbox";
			box.checked = modal.now.has(id);
			box.addEventListener("change", () => {
				if (box.checked) addToDraft(id);
				else modal.now.delete(id);
				renderAddList();
			});
			row.append(box);
			const text = el("div", "picker-text");
			text.append(el("span", "picker-label", session.title || L.untitled));
			const others = groupsOf(id).filter((item) => item.id !== group.id);
			const meta = el("span", "picker-meta");
			const time = fmtClock(session.updatedAt);
			meta.append(el("span", null, time));
			if (others.length > 0) meta.append(el("span", "chip", others.map((item) => item.name).join(" / ")));
			text.append(meta);
			row.append(text);
			section.append(row);
		}
		container.append(section);
	}
	if (total === 0) container.append(el("p", "empty", L.noMatch));
}

async function submitAddModal() {
	const group = groupById(modal.groupId);
	if (!group) {
		closeAddModal();
		return;
	}
	group.dirs = [...modal.dirs];
	group.ids = sortByUpdated([...modal.now]);
	await saveGroup(group);
	await saveMeta();
	closeAddModal();
	render();
}

/* ---------- 详情弹层 ---------- */

function infoRow(label, value, title) {
	const row = el("div", "info-row");
	row.append(el("span", "info-label", label));
	const text = el("span", "info-value", value);
	if (title) text.title = title;
	row.append(text);
	return row;
}

function openInfoModal(sessionId) {
	const session = state.sessions.get(sessionId);
	if (!session) return;
	$("info-title").textContent = L.detailTitle;
	$("info-overlay").hidden = false;
	const body = $("info-body");
	body.replaceChildren();
	body.append(el("p", "info-title-text", session.title || L.untitled));
	const groupNames = groupsOf(sessionId).map((group) => group.name);
	body.append(infoRow(L.fieldDirectory, session.directory || L.unknownDir, session.directory));
	if (session.projectName) body.append(infoRow(L.fieldProject, session.projectName));
	body.append(infoRow(L.fieldBackend, session.backend || "pi"));
	if (session.model) body.append(infoRow(L.fieldModel, session.model));
	body.append(infoRow(L.fieldGroups, groupNames.length > 0 ? groupNames.join(" / ") : L.noGroup));
	body.append(infoRow(L.fieldCreatedAt, fmtClock(session.createdAt)));
	body.append(infoRow(L.fieldUpdatedAt, fmtClock(session.updatedAt)));
	body.append(infoRow(L.fieldStatus, session.readable ? L.statusSaved : L.statusNoHistory));
	body.append(infoRow(L.fieldId, session.id));
}

function closeInfoModal() {
	$("info-overlay").hidden = true;
}

/* ---------- 事件绑定 ---------- */

function closeTopOverlay() {
	if (!$("info-overlay").hidden) return closeInfoModal();
	if (!$("create-overlay").hidden) return closeCreateModal();
	if (!$("overlay").hidden) return closeAddModal();
	return false;
}

function bindStaticControls() {
	$("btn-new").addEventListener("click", openCreateModal);
	$("btn-toggle-all").addEventListener("click", () => {
		if (anyCollapsed()) {
			state.collapsed.clear();
		} else {
			for (const group of state.groups) state.collapsed.add(group.id);
			state.collapsed.add(UNGROUPED);
		}
		void saveMeta();
		render();
	});

	const search = $("search-input");
	const applyFilter = debounce(() => {
		filterQuery = search.value.trim().toLowerCase();
		$("search-clear").hidden = filterQuery.length === 0;
		render();
	}, 120);
	search.addEventListener("input", applyFilter);
	$("search-clear").addEventListener("click", () => {
		search.value = "";
		filterQuery = "";
		$("search-clear").hidden = true;
		render();
		search.focus();
	});
	$("dir-filter").addEventListener("change", (event) => {
		dirFilter = event.target.value;
		ungroupedVisible = UNGROUPED_PAGE;
		render();
	});

	$("create-close").addEventListener("click", closeCreateModal);
	$("create-cancel").addEventListener("click", closeCreateModal);
	$("create-ok").addEventListener("click", () => void submitCreateModal().catch(actionError));
	$("create-name").addEventListener("input", updateCreateHint);
	$("create-name").addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void submitCreateModal().catch(actionError);
		}
	});
	$("create-dirs-all").addEventListener("click", () => {
		for (const entry of dirEntries()) createDraft.dirs.add(entry.key);
		renderCreateDirs();
	});
	$("create-dirs-none").addEventListener("click", () => {
		createDraft.dirs.clear();
		renderCreateDirs();
	});

	$("modal-close").addEventListener("click", closeAddModal);
	$("modal-cancel").addEventListener("click", closeAddModal);
	$("modal-save").addEventListener("click", () => void submitAddModal().catch(actionError));
	$("modal-search").addEventListener("input", renderAddList);
	$("info-close").addEventListener("click", closeInfoModal);

	for (const id of ["create-overlay", "overlay", "info-overlay"]) {
		$(id).addEventListener("click", (event) => {
			if (event.target === event.currentTarget) closeTopOverlay();
		});
	}
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (closeTopOverlay() !== false) event.preventDefault();
		else if (filterQuery) {
			$("search-input").value = "";
			filterQuery = "";
			$("search-clear").hidden = true;
			render();
		}
	});
}

/* ---------- 启动 ---------- */

async function boot() {
	bindStaticControls();
	state.ready = false;
	try {
		const context = await pideck.context.get();
		await applyContext(context || {});
	} catch (err) {
		setStatus(L.loadError + (err && err.message ? err.message : ""), true);
	}
	state.ready = true;
	render();
	pideck.onEvent(handleEvent);
	// 活跃点与相对时间会随时间漂移：每分钟静默重绘一次（不重新请求数据）
	setInterval(() => render(), 60_000);
}

void boot();
