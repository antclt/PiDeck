import type { AgentUiBatchQuestion } from "../../../shared/types";
import type { BatchAnswerValue } from "./askUi";

/** Preserve the card's answer semantics: false is valid, an empty multi-select is not. */
export function isBatchAnswered(value: BatchAnswerValue): boolean {
	return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
}

/** Inspect the submitted snapshot, including an answer not yet committed to the draft atom. */
export function inspectBatchAnswers(questions: AgentUiBatchQuestion[], answers: Record<string, BatchAnswerValue>): { complete: boolean; firstUnanswered: number } {
	const firstUnanswered = questions.findIndex((question) => !isBatchAnswered(answers[question.id]));
	return { complete: questions.length > 0 && firstUnanswered === -1, firstUnanswered };
}
