/**
 * Derive the thinking-level text from the latest runtime or catalog value.
 * The backend decides whether a live change affects the current turn, so the
 * renderer must not invent a separate "next turn" state.
 */
export type ThinkingDisplayResult = {
  levels: string[];
  pending: false;
};

export function computeThinkingDisplay(current: string | undefined): ThinkingDisplayResult {
  return {
    levels: current ? [current] : [],
    pending: false,
  };
}

/**
 * 底栏/选择器当前思考档位：只在 runtime 仍 live 时优先 state。
 * 与 resolveComposerLiveModel 同一规则，避免残留 state.thinkingLevel 盖住 catalog。
 */
export function resolveComposerThinkingLevel(input: {
  state?: string;
  record?: string;
  fallback?: string;
  isLive: boolean;
}): string | undefined {
  return (input.isLive ? input.state : undefined) ?? input.record ?? input.fallback;
}
