/**
 * 会话分组的共享契约。
 *
 * 分组是 PiDeck 自己的本地数据（<userData>/profile/session-groups.json），**不写入会话
 * 文件、不改 pi 协议**：只存「组名 + 颜色 + 会话 id 引用 + 目录范围」，不存会话内容。
 * 会话 id 是引用：目标会话被删除/替代后由渲染层按 catalog 过滤失效引用，store 不追删。
 *
 * 数据形状与内置宿主插件 session-groups v2 的存储同构（迁移零转换）；该插件 v3 起改为
 * 经宿主 sessionGroups.* API 读写同一份数据（见 docs/host-boundaries.md 例外七）。
 */

/** 分组色标（身份色枚举，与插件 UI 的色点一一对应；渲染层映射成具体色值）。 */
export const SESSION_GROUP_COLORS = ["blue", "green", "orange", "purple", "red", "cyan"] as const;
export type SessionGroupColor = (typeof SESSION_GROUP_COLORS)[number];

/** 名称长度上限（与插件「新建分组」输入框 maxlength 一致）。 */
export const SESSION_GROUP_NAME_MAX_CHARS = 80;
/** 分组条数上限：超出时主进程拒绝写入（插件 storage 配额语义的对等约束）。 */
export const SESSION_GROUP_COUNT_LIMIT = 200;
/** 单个分组的会话引用上限：超过说明数据异常（正常工作区远达不到），整组拒绝写入。 */
export const SESSION_GROUP_SESSION_LIMIT = 20_000;
/** 会话 id / 目录 key 等元信息长度上限。 */
export const SESSION_GROUP_META_MAX_CHARS = 200;
/** 单组目录范围上限：目录范围是勾选出来的项目根列表，正常工作区远达不到。 */
export const SESSION_GROUP_DIRS_MAX_KEYS = 500;

export type SessionGroup = {
	id: string;
	name: string;
	color: SessionGroupColor;
	/** 创建时刻（epoch ms）；仅展示用。 */
	createdAt: number;
	/** 组内会话引用（去重）；顺序不承载语义，展示按会话更新时间排。 */
	sessionIds: string[];
	/**
	 * 目录范围（dirKey 列表，空数组 = 不限目录）。dirKey 由插件按会话 directory 推导
	 * （项目根路径 / `name:<项目名>` / `project:<id>`），宿主把它当不透明字符串透传。
	 */
	dirs: string[];
};

/** 渲染层/插件提交的分组写入入参（主进程按白名单收窄，多余字段丢弃）。 */
export type SaveSessionGroupInput = {
	id: string;
	name: string;
	color: SessionGroupColor;
	createdAt?: number;
	sessionIds?: string[];
	dirs?: string[];
};
