/**
 * 微信桥接的主进程侧文案。
 *
 * 为什么不能复用渲染层词典：这些字符串是**发给微信用户的消息**，不是界面文字——
 * 主进程要在没有窗口（甚至窗口已关）时也能生成，且必须与界面语言解耦（用户可能
 * 用英文界面但微信里说中文）。飞书域同样是独立词典，这里沿用同一结构。
 *
 * 与飞书的关键差别：微信没有卡片，所有引导只能是一行行纯文本，所以这里的文案
 * 密度更高（帮助信息一次给全）、更少（没有按钮/表单可跳转）。
 */

const zhCN = {
	"help.title": "PiDeck 微信桥接命令：",
	"help.body": ["/new 新建会话（换一个话题）", "/stop 中断当前任务", "/status 查看会话状态", "/model 查看或切换模型", "/help 显示本帮助"].join("\n"),
	"help.hint": "直接发消息即可对话。微信本通道不支持主动推送，Agent 结果会在处理完成后回复给你。",

	"project.required": "PiDeck 还没有配置项目，请先在电脑上添加项目再使用。",
	"session.created": "已创建新会话（{id}）。",
	"session.createFailed": "创建会话失败，请查看电脑端 PiDeck 日志。",
	"session.backendUnavailable": "当前选择的会话后端（DSH）不可用，请先在电脑端启动 DSH 运行时，或在「设置 → 外部连接 → 微信」里改回 pi。",
	"session.backendSwitched": "会话后端已切换为 {backend}，本对话已换用新会话（{id}）。之前的对话仍保留在原会话里。",
	"session.restoreFailed": "会话恢复失败，请发送 /new 重新开始。",
	"session.none": "当前还没有会话，直接发送消息即可创建。",
	"session.status": "会话 {id}\n工作区：{workspace}\n模型：{model}\n状态：{state}",
	"session.stateIdle": "空闲",
	"session.stateRunning": "运行中",
	"session.stateBridgeOnly": "运行中（桥接锁占用，后端已空闲；发送 /stop 可释放）",
	"session.stateBackendOnly": "运行中（由桌面端发起）",
	"session.queued": "排队：{count} 条",

	"run.queued": "已排队第 {position} 位，当前任务结束后自动处理；发送 /stop 可清空队列。",
	"run.queueFull": "排队已满（{limit} 条），这条消息没有执行；发送 /stop 可清空队列。",
	"run.stoppedWithQueue": "已中断当前任务，并清空排队中的 {count} 条消息。",
	"run.accepted": "收到，正在处理…",
	"run.timeout": "任务还在运行中。微信通道不能主动推送，完成后我会把结果发给你（若超过 24 小时未发送则可能失败）。",
	"run.failed": "处理失败：{message}",
	"run.stopped": "已中断当前任务。",
	"run.nothing": "当前没有正在运行的任务。",
	"run.noText": "任务已完成，但没有可回复的文本输出。",
	"run.failedNoDetail": "处理失败：后端没有返回具体错误信息，请在电脑端 PiDeck 的日志里查看详情。",

	"login.required": "微信登录已失效，请在电脑端 PiDeck 的「集成 → 微信」里重新扫码。",

	"text.attachmentUnsupported": "收到{kind}，微信通道暂不支持处理；需要发文件请改用飞书。",
	"text.kindImage": "图片",
	"text.kindVoice": "语音",
	"text.kindFile": "文件",
	"text.kindVideo": "视频",
	"text.kindAttachment": "附件",
	"text.group": "暂不支持群聊，请私聊我。",

	"model.current": "当前模型：{model}",
	"model.switched": "已切换到 {model}。",
	"model.empty": "没有可用模型，请先在电脑端配置供应商。",
	"model.invalid": "找不到模型 {model}，发送 /model 查看列表。",
	"model.usage": "用法：/model 查看列表，或 /model <名称> 切换。",

	"marker.removed": "（附件与文件发送在微信通道暂不支持）",
} as const;

export type WeChatTranslationKey = keyof typeof zhCN;

const enUS: Record<WeChatTranslationKey, string> = {
	"help.title": "PiDeck WeChat bridge commands:",
	"help.body": ["/new Start a new session", "/stop Abort the current task", "/status Show session status", "/model List or switch models", "/help Show this help"].join("\n"),
	"help.hint": "Just send a message to chat. This channel cannot push messages, so results are delivered as a reply once the run finishes.",

	"project.required": "No project is configured in PiDeck yet. Add one on the desktop app first.",
	"session.created": "Created a new session ({id}).",
	"session.createFailed": "Failed to create a session. Check the PiDeck desktop log.",
	"session.backendUnavailable": "The selected session backend (DSH) is not available. Start the DSH runtime on the desktop app, or switch back to pi in Settings → External connections → WeChat.",
	"session.backendSwitched": "The session backend switched to {backend}. This chat now uses a new session ({id}); the earlier conversation stays in the previous session.",
	"session.restoreFailed": "Failed to restore the session. Send /new to start over.",
	"session.none": "No session yet — just send a message to create one.",
	"session.status": "Session {id}\nWorkspace: {workspace}\nModel: {model}\nState: {state}",
	"session.stateIdle": "Idle",
	"session.stateRunning": "Running",
	"session.stateBridgeOnly": "Running (bridge lock held, backend idle — send /stop to release)",
	"session.stateBackendOnly": "Running (started from the desktop app)",
	"session.queued": "Queued: {count}",

	"run.queued": "Queued at position {position}. It will run automatically once the current task finishes; send /stop to clear the queue.",
	"run.queueFull": "The queue is full ({limit} messages), so this message was not queued or run. Send /stop to clear the queue.",
	"run.stoppedWithQueue": "Aborted the current task and cleared {count} queued message(s).",
	"run.accepted": "Got it, working on it…",
	"run.timeout": "The task is still running. This channel cannot push messages, so I will reply with the result once it finishes (if it exceeds the 24h window the send may fail).",
	"run.failed": "Failed: {message}",
	"run.stopped": "Aborted the current task.",
	"run.nothing": "No task is currently running.",
	"run.noText": "The task finished but produced no text to reply with.",
	"run.failedNoDetail": "Failed: the backend returned no error detail. Check the PiDeck desktop log for specifics.",

	"login.required": "The WeChat login has expired. Re-scan the QR code in PiDeck → Integrations → WeChat.",

	"text.attachmentUnsupported": "Received {kind}. This WeChat channel cannot process attachments yet — use Feishu to send files.",
	"text.kindImage": "an image",
	"text.kindVoice": "voice",
	"text.kindFile": "a file",
	"text.kindVideo": "a video",
	"text.kindAttachment": "an attachment",
	"text.group": "Group chats are not supported yet — please DM me.",

	"model.current": "Current model: {model}",
	"model.switched": "Switched to {model}.",
	"model.empty": "No models available. Configure a provider in the desktop app first.",
	"model.invalid": "Unknown model {model}. Send /model to list them.",
	"model.usage": "Usage: /model to list, or /model <name> to switch.",

	"marker.removed": "(Attachments and file sending are not supported on the WeChat channel yet)",
};

export type WeChatLocale = "zh-CN" | "zh-TW" | "en-US";

export function normalizeWeChatLocale(locale: string | undefined): WeChatLocale {
	if (!locale) return "zh-CN";
	const lower = locale.toLowerCase();
	if (lower.startsWith("en")) return "en-US";
	if (lower.includes("tw") || lower.includes("hk") || lower.includes("hant")) return "zh-TW";
	return "zh-CN";
}

/** 给 Agent 的提示里说明用户语言，避免中文界面收到英文回答。 */
export function weChatLanguage(locale: WeChatLocale): string {
	return locale === "en-US" ? "English" : "Chinese";
}

export function wechatT(locale: WeChatLocale, key: WeChatTranslationKey, params?: Record<string, string | number>): string {
	const dictionary: Record<WeChatTranslationKey, string> = locale === "en-US" ? enUS : zhCN;
	const template = dictionary[key] ?? zhCN[key] ?? key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
