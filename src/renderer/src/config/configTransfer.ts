/**
 * 配置导出/导入的浏览器侧文件动作（从 ConfigModal 抽出的薄 helper，保持 3205 行预算只降不升）。
 * 只做「拿 JSON 文本 / 下载 JSON」这两件与 React 无关的事；读取哪份配置、写哪份草稿仍由 ConfigModal 决定。
 */

/** 把配置 JSON 作为文件下载（文件名含日期，便于区分多次备份）。 */
export function downloadConfigJson(json: string, fileName: string): void {
	const blob = new Blob([json], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
}

/** 让用户选择一个 .json 并读出文本；取消选择返回 null（不抛错）。 */
export function pickJsonFileText(): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) {
				resolve(null);
				return;
			}
			try {
				resolve(await file.text());
			} catch (error) {
				reject(error);
			}
		};
		input.click();
	});
}
