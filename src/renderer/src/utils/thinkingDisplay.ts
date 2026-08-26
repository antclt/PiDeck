/**
 * 思考强度「待生效」显示推导（issue #146）。
 *
 * pi 的 set_thinking_level RPC 在流式生成中也可调用：飞行中的生成仍使用旧档位，
 * 新档位在下一个 turn 边界（下一轮 LLM 请求）才实际生效。因此 UI 需要区分
 * 「当前生效档位」与「已请求、下一轮才生效的档位」，即 issue 提出的 xhigh->max 指示。
 * 本模块只做纯推导，不依赖 React，便于单测。
 */

export type ThinkingLevelPending = {
  /** 切换前档位：仍在被飞行中生成使用的档位 */
  from: string;
  /** 请求切换的目标档位：将在下一轮生成生效 */
  to: string;
};

export type ThinkingDisplayResult = {
  /** 展示的档位值序列：正常为 [current]，存在待生效切换时为 [from, to] */
  levels: string[];
  /** 是否存在待生效切换 */
  pending: boolean;
};

/**
 * 由「当前档位 + 待生效切换」推导底栏展示。
 * - 有待生效切换：优先展示 from→to（新档位尚未被任何生成使用，不能直接亮出）。
 * - 无待生效切换：展示当前档位；无任何档位信息时返回空序列（调用方显示兜底文案）。
 */
export function computeThinkingDisplay(
  current: string | undefined,
  pending: ThinkingLevelPending | undefined,
): ThinkingDisplayResult {
  if (pending) {
    return { levels: [pending.from, pending.to], pending: true };
  }
  return { levels: current ? [current] : [], pending: false };
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
