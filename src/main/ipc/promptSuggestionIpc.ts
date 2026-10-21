/**
 * 输入预测 IPC handler（薄层：只做入参校验与适配，业务在 EnhancePromptService）。
 *
 * 与 enhance:run 的差别只有两处：systemPrompt / userText 由主进程填（渲染层无权传），
 * 且 purpose="suggest" 让 sidecar 不再追加「改写最后一条草稿」的约束。
 * 事件回发给发起方（event.sender），多窗口/多分屏各自只收自己发起的 run。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { EnhanceEventPayload } from "../../shared/types/enhance";
import type { PromptSuggestionRunInput, PromptSuggestionRunResult } from "../../shared/types/promptSuggestion";
import type { EnhancePromptService } from "../pi/enhance/EnhancePromptService";
import { PROMPT_SUGGESTION_SYSTEM_PROMPT, PROMPT_SUGGESTION_USER_TEXT } from "../pi/enhance/promptSuggestion";
import { isModelId, parseContextMessages } from "./enhancePayloadValidation";

/** 输入预测必须有上下文：没有历史就没有预测依据，空数组按无效入参拒绝。 */
function parseSuggestionRunInput(value: unknown): PromptSuggestionRunInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid suggestion input: not an object");
	const record = value as Record<string, unknown>;
	if (!isModelId(record.provider)) throw new Error("Invalid suggestion input: provider");
	if (!isModelId(record.modelId)) throw new Error("Invalid suggestion input: modelId");
	const context = parseContextMessages(record.context, "suggestion");
	if (!context.length) throw new Error("Invalid suggestion input: context");
	return { provider: record.provider, modelId: record.modelId, context };
}

export function registerPromptSuggestionIpc(ipc: IpcMain, service: EnhancePromptService | null): void {
	const requireService = (): EnhancePromptService => {
		if (!service) throw new Error("Prompt suggestion service is not available");
		return service;
	};

	ipc.handle(ipcChannels.suggestRun, async (event, input: unknown): Promise<PromptSuggestionRunResult> => {
		const parsed = parseSuggestionRunInput(input);
		const sender = event.sender;
		// runId 先受理后知晓：回调经槽位读取，窗口销毁后静默丢弃。
		const state: { runId: string } = { runId: "" };
		const send = (payload: EnhanceEventPayload) => {
			if (!sender.isDestroyed()) sender.send(ipcChannels.suggestEvent, payload);
		};
		const result = await requireService().enhance(
			{ provider: parsed.provider, modelId: parsed.modelId, userText: PROMPT_SUGGESTION_USER_TEXT, context: parsed.context, systemPrompt: PROMPT_SUGGESTION_SYSTEM_PROMPT, purpose: "suggest" },
			{
				onDelta: (text) => send({ runId: state.runId, phase: "delta", text }),
				onDone: (text) => send({ runId: state.runId, phase: "done", text }),
				onAborted: () => send({ runId: state.runId, phase: "aborted" }),
				onError: (errorKind, message) => send({ runId: state.runId, phase: "error", errorKind, message }),
			},
		);
		if (result.ok) {
			state.runId = result.runId;
			send({ runId: state.runId, phase: "started" });
		}
		return result;
	});

	ipc.handle(ipcChannels.suggestCancel, async () => {
		requireService().cancel();
		return { ok: true };
	});
}
