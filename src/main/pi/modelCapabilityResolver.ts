import type { ModelSpec } from "../../shared/types/modelSpecs";
import {
  findModelCapabilityMatch,
  modelCapabilityMatchToSpec,
  type ModelCapabilityCandidate,
  type ModelCapabilityLookupInput,
} from "./modelCapabilityMatch";
import {
  getPiAiCatalogEntries,
  type PiAiCatalogIndex,
} from "./piAiBuiltinCatalog";

function asInput(values: readonly string[] | undefined): Array<"text" | "image"> | undefined {
  if (!values) return undefined;
  const input = values.filter((value): value is "text" | "image" => value === "text" || value === "image");
  return input.length > 0 ? input : undefined;
}

function piAiCandidates(index: PiAiCatalogIndex): ModelCapabilityCandidate[] {
  return getPiAiCatalogEntries(index).flatMap((entry) => {
    const provider = entry.provider?.trim();
    if (!provider || !entry.id.trim()) return [];
    return [{
      source: "pi-ai" as const,
      provider,
      id: entry.id,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
      ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
      ...(asInput(entry.input) ? { input: asInput(entry.input) } : {}),
      ...(entry.thinkingLevelMap ? { thinkingLevelMap: { ...entry.thinkingLevelMap } } : {}),
    }];
  });
}

/**
 * 配置阶段的自适应模板解析：只读 PiDeck 自带的 @earendil-works/pi-ai bundled catalog。
 * 不读 capability cache（那是输入框/思考强度的运行时快照，属于另一个消费面），
 * 也不读外部 Pi 安装目录的 catalog。endpoint /models 实报字段由渲染层在
 * mergeAdaptiveModelTemplate 中优先合并，这里只负责已知标准模型的模板匹配。
 */
export function resolveModelSpecFromPiCatalogs(
  input: ModelCapabilityLookupInput,
  index: PiAiCatalogIndex,
): ModelSpec | null {
  const match = findModelCapabilityMatch(input, piAiCandidates(index));
  return match ? modelCapabilityMatchToSpec(match) : null;
}
