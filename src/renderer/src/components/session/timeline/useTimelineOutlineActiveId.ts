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
import {
  resolveActiveOutlineItemId,
  type OutlineItemPosition,
} from "./outlineRailActive";

const OUTLINE_VIEWPORT_ANCHOR_OFFSET = 28;
const CONTENT_MEASURE_INTERVAL_MS = 120;

type TimelineOutlineItem = {
  id: string;
};

/**
 * Synchronizes the outline rail with the user-message checkpoint at the top of
 * the timeline. Message geometry is measured only after layout changes; scroll
 * frames use cached content offsets and a binary search.
 */
export function useTimelineOutlineActiveId(
  timelineRef: RefObject<HTMLElement | null> | undefined,
  items: readonly TimelineOutlineItem[],
): readonly [
  string | undefined,
  Dispatch<SetStateAction<string | undefined>>,
] {
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const itemIdKey = useMemo(() => items.map((item) => item.id).join("\u0000"), [items]);
  const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [itemIdKey]);
  const itemIdsRef = useRef<ReadonlySet<string>>(itemIds);
  itemIdsRef.current = itemIds;
  const positionsRef = useRef<readonly OutlineItemPosition[]>([]);

  const updateActiveId = useCallback((nextActiveId: string | undefined) => {
    if (activeIdRef.current === nextActiveId) return;
    activeIdRef.current = nextActiveId;
    setActiveId(nextActiveId);
  }, []);

  const setTrackedActiveId = useCallback<Dispatch<SetStateAction<string | undefined>>>(
    (next) => {
      updateActiveId(
        typeof next === "function" ? next(activeIdRef.current) : next,
      );
    },
    [updateActiveId],
  );

  const measurePositions = useCallback(() => {
    const timeline = timelineRef?.current;
    const ids = itemIdsRef.current;
    if (!timeline || ids.size === 0) {
      positionsRef.current = [];
      return;
    }

    const contentOrigin = timeline.getBoundingClientRect().top - timeline.scrollTop;
    const positions: OutlineItemPosition[] = [];
    for (const element of timeline.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = element.dataset.messageId;
      if (!id || !ids.has(id)) continue;
      const top = element.getBoundingClientRect().top - contentOrigin;
      if (Number.isFinite(top)) positions.push({ id, top });
    }
    positionsRef.current = positions;
  }, [timelineRef]);

  const syncActiveId = useCallback(() => {
    const timeline = timelineRef?.current;
    const ids = itemIdsRef.current;
    if (ids.size === 0) {
      positionsRef.current = [];
      updateActiveId(undefined);
      return;
    }
    if (!timeline) return;

    updateActiveId(
      resolveActiveOutlineItemId(
        positionsRef.current,
        timeline.scrollTop + OUTLINE_VIEWPORT_ANCHOR_OFFSET,
      ),
    );
  }, [timelineRef, updateActiveId]);

  useLayoutEffect(() => {
    measurePositions();
    syncActiveId();
  }, [itemIdKey, measurePositions, syncActiveId]);

  useEffect(() => {
    const timeline = timelineRef?.current;
    if (!timeline) return;

    const content = timeline.querySelector<HTMLElement>("[role=\"log\"]");
    const messageList = content?.querySelector<HTMLElement>(".message-list");
    let frame: number | undefined;
    let measureBeforeSync = false;
    let contentMeasureTimer: number | undefined;
    let lastContentMeasureAt = performance.now();

    const flush = () => {
      frame = undefined;
      if (measureBeforeSync) {
        measureBeforeSync = false;
        measurePositions();
        lastContentMeasureAt = performance.now();
      }
      syncActiveId();
    };
    const scheduleSync = (measure = false) => {
      measureBeforeSync ||= measure;
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(flush);
    };
    const scheduleContentMeasurement = () => {
      const remaining = CONTENT_MEASURE_INTERVAL_MS -
        (performance.now() - lastContentMeasureAt);
      if (remaining <= 0) {
        scheduleSync(true);
        return;
      }
      if (contentMeasureTimer !== undefined) return;
      contentMeasureTimer = window.setTimeout(() => {
        contentMeasureTimer = undefined;
        scheduleSync(true);
      }, remaining);
    };

    const handleScroll = () => scheduleSync();
    timeline.addEventListener("scroll", handleScroll, { passive: true });
    const viewportResizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => scheduleSync(true));
    viewportResizeObserver?.observe(timeline);
    const contentResizeObserver = typeof ResizeObserver === "undefined" || !content
      ? undefined
      : new ResizeObserver(scheduleContentMeasurement);
    if (content) contentResizeObserver?.observe(content);
    const messageListObserver = typeof MutationObserver === "undefined" || !messageList
      ? undefined
      : new MutationObserver(() => scheduleSync(true));
    const handleMessageAnimationEnd = (event: AnimationEvent) => {
      if (event.animationName === "message-enter" || event.animationName === "top-enter") {
        scheduleSync(true);
      }
    };
    if (messageList) {
      messageListObserver?.observe(messageList, { childList: true });
      // Transform animations do not notify ResizeObserver; refresh their final layout position.
      messageList.addEventListener("animationend", handleMessageAnimationEnd, true);
    }
    scheduleSync(true);

    return () => {
      timeline.removeEventListener("scroll", handleScroll);
      viewportResizeObserver?.disconnect();
      contentResizeObserver?.disconnect();
      messageListObserver?.disconnect();
      messageList?.removeEventListener("animationend", handleMessageAnimationEnd, true);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (contentMeasureTimer !== undefined) window.clearTimeout(contentMeasureTimer);
    };
  }, [itemIdKey, measurePositions, syncActiveId, timelineRef]);

  return [activeId, setTrackedActiveId];
}