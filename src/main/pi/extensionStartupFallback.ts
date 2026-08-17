/**
 * 扩展导致 pi RPC 起不来时的启动回退策略。
 *
 * 背景：内置扩展依赖 pi 自带的 @earendil-works/*。全局 pi 残缺时，
 * `--extension` 加载失败会让进程 exit 1，用户体感是「消息发不出去」。
 * 桌面端在首次启动失败后用 --no-extensions 再试一次，让会话先能用。
 */

export type ExtensionFallbackDecisionInput = {
	/** 用户或上次回退已经开了 --no-extensions，再试没有意义。 */
	alreadyNoExtensions: boolean;
	stderr?: string;
	errorMessage?: string;
	exitCode?: number | null;
	/**
	 * 进程仍在跑：多半是 get_state 超时/慢启动，而不是扩展把进程打死。
	 * 这时杀进程改无扩展会误伤，必须跳过。
	 */
	processStillRunning?: boolean;
};

/**
 * 是否值得用 --no-extensions 再启动一次。
 * 不重试：已禁用扩展、pi 本体不存在、WSL 不可用、进程还活着（超时）。
 * 重试：明确扩展加载失败，或进程已非 0 退出 / 报 pi exited。
 */
export function shouldRetryWithoutExtensions(input: ExtensionFallbackDecisionInput): boolean {
	if (input.alreadyNoExtensions) return false;
	if (input.processStillRunning) return false;

	const text = `${input.stderr ?? ""}\n${input.errorMessage ?? ""}`;
	if (/\bENOENT\b/.test(text) && /spawn/i.test(text)) return false;
	if (/WSL distribution is unavailable/i.test(text)) return false;

	if (/Failed to load extension/i.test(text)) return true;
	if (/Cannot find module/.test(text) && /extension/i.test(text)) return true;
	if (typeof input.exitCode === "number" && input.exitCode !== 0) return true;
	if (/pi exited\s*:/i.test(text)) return true;
	return false;
}

/** 从 stderr 抽出扩展加载失败行，方便用户把诊断贴进聊天让 AI 分析。 */
export function extractExtensionLoadHints(stderr: string): string[] {
	const lines = stderr
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const hints: string[] = [];
	for (const line of lines) {
		if (/Failed to load extension/i.test(line) || /Cannot find module/.test(line)) {
			hints.push(line);
		}
	}
	return [...new Set(hints)].slice(0, 8);
}

/** 回退成功后写入系统消息 debugDetails 的原文（不走 i18n，给 AI/Issue 看）。 */
export function formatExtensionFallbackDebug(input: {
	rawMessage: string;
	stderr: string;
	exitCode?: number | null;
}): string {
	const lines: string[] = [];
	if (input.exitCode !== null && input.exitCode !== undefined) {
		lines.push(`First start exit code: ${input.exitCode}`);
	}
	if (input.rawMessage.trim()) {
		lines.push(input.rawMessage.trim());
	}
	const hints = extractExtensionLoadHints(input.stderr);
	if (hints.length > 0) {
		lines.push("Extension load errors:");
		lines.push(...hints);
	} else {
		const stderrText = input.stderr.trim();
		if (stderrText) {
			const snippet = stderrText.length > 600 ? `…${stderrText.slice(-600)}` : stderrText;
			lines.push(`Process stderr:\n${snippet}`);
		}
	}
	return lines.join("\n");
}
