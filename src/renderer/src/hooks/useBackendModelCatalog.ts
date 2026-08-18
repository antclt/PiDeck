import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBackend, AvailableModel } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";

/**
 * 后端模型目录数据源（C19）：统一「按 backend 加载模型列表」——
 * DSH 会话走 host 级 llm.models（listDshModels），pi 走 projects.listModels
 *（优先 pi --list-models，失败回退本地 models.json）。enabled=false 时不加载
 *（选择器打开才拉取，避免常驻轮询）；
 * 内部带 sequence 防竞态（快速开关选择器时旧响应不覆盖新响应）。
 */
export function useBackendModelCatalog(options: {
  sessionId: string;
  backend?: AgentBackend;
  projectId?: string;
  enabled: boolean;
}): { models: AvailableModel[]; reload: () => void } {
  const [models, setModels] = useState<AvailableModel[]>([]);
  const sequenceRef = useRef(0);

  const load = useCallback(() => {
    if (!options.enabled) return;
    const sequence = ++sequenceRef.current;
    const loader = options.backend === "dsh"
      ? desktopApi.sessions.listDshModels()
      : desktopApi.projects.listModels(options.projectId);
    void loader.then((next) => {
      if (sequence === sequenceRef.current) setModels(next);
    }).catch((error) => {
      if (sequence === sequenceRef.current) {
        setModels([]);
        showNotice(error instanceof Error ? error.message : String(error), 4000);
      }
    });
  }, [options.enabled, options.backend, options.projectId]);

  useEffect(() => {
    load();
  }, [load]);

  return { models, reload: load };
}
