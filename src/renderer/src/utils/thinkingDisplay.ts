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
