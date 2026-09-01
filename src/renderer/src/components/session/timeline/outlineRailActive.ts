/**
 * Pure selection rules for the session outline rail.
 *
 * The rail only renders user-message checkpoints. The active checkpoint follows
 * the last one at or above the viewport anchor, falling back to the first one
 * below the anchor when the viewport starts before the first checkpoint.
 */
export type OutlineItemWithId = {
  id: string;
};

export type OutlineItemPosition = {
  id: string;
  top: number;
};

export function resolveActiveOutlineItemId(
  positions: readonly OutlineItemPosition[],
  anchorOffset: number,
): string | undefined {
  let activeId: string | undefined;

  for (const position of positions) {
    if (!Number.isFinite(position.top)) continue;
    if (position.top > anchorOffset) return activeId ?? position.id;
    activeId = position.id;
  }

  return activeId;
}

/**
 * A long history may be sampled to fit the available rail height. Keep the
 * current location visible by highlighting the closest rendered checkpoint.
 */
export function resolveVisibleRailActiveId<T extends OutlineItemWithId>(
  activeId: string | undefined,
  sourceItems: readonly T[],
  railItems: readonly T[],
): string | undefined {
  if (!activeId) return undefined;

  const sourceIndex = sourceItems.findIndex((item) => item.id === activeId);
  if (sourceIndex < 0) return undefined;
  if (railItems.some((item) => item.id === activeId)) return activeId;

  const firstRailItem = railItems[0];
  if (!firstRailItem) return undefined;

  let nearestId = firstRailItem.id;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const railItem of railItems) {
    const railIndex = sourceItems.findIndex((item) => item.id === railItem.id);
    if (railIndex < 0) continue;
    const distance = Math.abs(railIndex - sourceIndex);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestId = railItem.id;
    }
  }

  return nearestId;
}
