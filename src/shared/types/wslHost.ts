/**
 * WSL 连接档案（第 9 步）。
 *
 * 只有 label/distro/user：没有密码、没有 home 推导结果（可刷新缓存），也不与 SSH 的
 * host key pin / route digest 混用。项目与会话通过 `wslHostId` 引用档案；引用扫描在 main。
 */
export type WslHostProfile = {
	id: string;
	label: string;
	distro: string;
	user: string;
	createdAt: string;
	updatedAt: string;
};

export type WslHostListItem = Pick<WslHostProfile, "id" | "label" | "distro" | "user">;

export type WslHostListResult = { ok: true; hosts: WslHostListItem[] } | { ok: false; code: string };

export type WslHostAddInput = { label: string; distro: string; user: string };

/** 只允许改显示名/发行版/用户；id 与时间戳由主进程持有。 */
export type WslHostUpdateInput = Partial<Pick<WslHostProfile, "label" | "distro" | "user">>;

export type WslHostMutationResult = { ok: true; host: WslHostListItem } | { ok: false; code: string };

export type WslHostRemoveResult = { ok: true; id: string } | { ok: false; code: string };
