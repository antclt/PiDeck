export type SessionOutlineItems = Array<{
  id: string;
  role: string;
  title: string;
  time: string;
}>;

type CachedOutlineProjection = {
  revision: number;
  items: SessionOutlineItems;
};

const cachedProjectionsBySessionId = new Map<string, CachedOutlineProjection>();

/** Returns the current projection only when its source outline revision still matches. */
export function getSessionOutlineProjection(
  sessionId: string,
  revision: number,
): SessionOutlineItems | undefined {
  const cached = cachedProjectionsBySessionId.get(sessionId);
  return cached?.revision === revision ? cached.items : undefined;
}

/** Stores the latest projection under the same lifecycle boundary as message caching. */
export function setSessionOutlineProjection(
  sessionId: string,
  revision: number,
  items: SessionOutlineItems,
): void {
  cachedProjectionsBySessionId.set(sessionId, { revision, items });
}

/** Releases projections when their message-cache entry is invalidated or evicted. */
export function releaseSessionOutlineProjection(sessionId: string): void {
  cachedProjectionsBySessionId.delete(sessionId);
}