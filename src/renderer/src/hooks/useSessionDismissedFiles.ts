import { atom, useAtom } from "jotai";
import { useCallback } from "react";

/**
 * 文件列表“保存全部”清空快照：sessionId -> (path -> 清空时刻的 count)。
 * 只有新出现的改动（新路径或同路径 count 增长）才重新展示，已清空条目不再出现。
 *
 * 弹层（SessionWidgetsPopover，保存全部按钮）与分段条徽标（SessionWidgetsCard，
 * 未清空文件数）跨组件共享同一份状态，所以用 atom 而非各自 localStorage state。
 */

const DISMISSED_FILES_KEY = "pid:session-dismissed-files-v1";
type DismissedFileCounts = Record<string, Record<string, number>>;

function loadDismissed(): DismissedFileCounts {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_FILES_KEY) ?? "{}") as DismissedFileCounts;
  } catch {
    return {};
  }
}

/** 模块级缓存：一次加载，跨组件共享；保存时同步写回 localStorage（best-effort）。 */
let cachedCounts: DismissedFileCounts | null = null;
const dismissedFileCountsAtom = atom<DismissedFileCounts>(cachedCounts ?? (cachedCounts = loadDismissed()));

export function useSessionDismissedFiles(sessionId: string): {
  /** 当前会话的清空快照（path -> count），无记录为 undefined */
  snapshot: Record<string, number> | undefined;
  /** 按“当前所有文件条目”记录清空快照并持久化 */
  dismissAll: (entries: readonly { path: string; count: number }[]) => void;
} {
  const [all, setAll] = useAtom(dismissedFileCountsAtom);

  const dismissAll = useCallback(
    (entries: readonly { path: string; count: number }[]) => {
      const snapshot: Record<string, number> = {};
      for (const e of entries) snapshot[e.path] = e.count;
      const next = { ...all, [sessionId]: snapshot };
      try {
        localStorage.setItem(DISMISSED_FILES_KEY, JSON.stringify(next));
      } catch {
        /* best-effort */
      }
      setAll(next);
    },
    [all, sessionId],
  );

  return { snapshot: all[sessionId], dismissAll };
}
