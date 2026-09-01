/** 会话级文件修改汇总条目（跨进程契约：main 聚合、renderer 展示）。 */
export type SessionFileChange = {
	path: string;
	/** 会话内该文件被 write/edit/create/patch 命中的总次数。 */
	count: number;
	/** 最后一次修改的旧内容（write/create 无旧内容 = 空串，展示为整文件新增）。 */
	originalContent: string;
	/** 最后一次修改的新内容（edit/patch 为变动区域）。 */
	content: string;
};
