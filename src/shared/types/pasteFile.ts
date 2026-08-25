/**
 * 粘贴大文本 → 落盘文件 的契约类型。
 * 渲染层只持有元数据（chip 展示用），文件内容只存在于主进程受管目录：
 * 有项目 → `<project>/.pideck-paste/`（pi 工作区内，@ 引用可被展开）；
 * 匿名会话 → `userData/paste-files/`（发送时折叠为原样文本内联）。
 */
export type PasteFileWriteInput = {
	/** 会话所属项目根路径；空串 = 匿名会话（写 userData 受管目录） */
	projectPath: string;
	content: string;
};

export type PasteFileWriteResult = {
	/** 落盘绝对路径 */
	path: string;
	fileName: string;
	bytes: number;
	/** 是否位于 pi 工作区（项目内）：true 时发送走 @"path" 引用，false 时折叠原样文本 */
	inProject: boolean;
};
