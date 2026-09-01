import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { resolveActiveOutlineItemId } from "./outlineRailActive";

const OUTLINE_VIEWPORT_ANCHOR_OFFSET = 28;

type TimelineOutlineItem = {
  id: string;
};

/**
 * Synchronizes the outline rail with the user-message checkpoint currently
 * visible at the top of the timeline viewport. Scroll reads are rAF-coalesced
 * so streaming and trackpad input do not cause one React update per event.
 */
export function useTimelineOutlineActiveId(
  timelineRef: RefObject<HTMLElement | null> | undefined,
  items: readonly TimelineOutlineItem[],
): readonly [
  string | undefined,
  Dispatch<SetStateAction<string | undefined>>,
] {
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const itemIdKey = useMemo(() => items.map((item) => item.id).join("\u0000"), [items]);
  const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [itemIdKey]);
  const itemIdsRef = useRef<ReadonlySet<string>>(itemIds);
  itemIdsRef.current = itemIds;

  const syncActiveId = useCallback(() => {
    const timeline = timelineRef?.current;
    const ids = itemIdsRef.current;
    if (ids.size === 0) {
      setActiveId(undefined);
      return;
    }
    if (!timeline) return;

    const viewportTop = timeline.getBoundingClientRect().top;
    const positions = [];
    for (const element of timeline.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = element.dataset.messageId;
      if (!id || !ids.has(id)) continue;
      positions.push({ id, top: element.getBoundingClientRect().top - viewportTop });
    }

    const nextActiveId = resolveActiveOutlineItemId(
      positions,
      OUTLINE_VIEWPORT_ANCHOR_OFFSET,
    );
    if (nextActiveId === undefined) return;
    setActiveId((currentId) => currentId === nextActiveId ? currentId : nextActiveId);
  }, [timelineRef]);

  useLayoutEffect(() => {
    syncActiveId();
  }, [itemIdKey, syncActiveId]);

  useEffect(() => {
    const timeline = timelineRef?.current;
    if (!timeline) return;

    let frame: number | undefined;
    const scheduleSync = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        syncActiveId();
      });
    };

    timeline.addEventListener("scroll", scheduleSync, { passive: true });
    // The viewport height is fixed while turn details expand or collapse.
    const content = timeline.querySelector<HTMLElement>("[role=\"log\"]");
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(timeline);
    if (content) resizeObserver?.observe(content);
    scheduleSync();

    return () => {
      timeline.removeEventListener("scroll", scheduleSync);
      resizeObserver?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [syncActiveId, timelineRef]);

  return [activeId, setActiveId];
}
