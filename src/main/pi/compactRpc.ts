/**
 * Build the compact RPC command accepted by both legacy and current pi clients.
 *
 * pi 0.84 renamed the custom compaction instruction field from `prompt` to
 * `customInstructions`. Older pi releases ignore the new field, while current
 * releases read `customInstructions`; sending both keeps existing installations
 * working without making the caller perform a fragile version probe.
 */
export type CompactRpcRequest = {
	type: "compact";
	/** Legacy pi field, retained for pre-0.84 clients. */
	prompt?: string;
	/** Current pi field (0.84+). */
	customInstructions?: string;
};

/** Create a compact command with version-compatible custom instructions. */
export function createCompactRpcRequest(prompt?: string): CompactRpcRequest {
	const trimmed = prompt?.trim();
	if (!trimmed) return { type: "compact" };
	return {
		type: "compact",
		// TODO(remove-compat): remove `prompt` after PiDeck raises its minimum pi
		// version to 0.84+ and completes the documented migration window.
		prompt: trimmed,
		customInstructions: trimmed,
	};
}
