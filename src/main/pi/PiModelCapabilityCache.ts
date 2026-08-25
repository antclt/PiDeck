import { watch, type FSWatcher } from "node:fs";
import type { AvailableModel } from "../../shared/types";
import {
  isUnsupportedThinkingLevelsRpcError,
  parseAvailableThinkingLevelsResponse,
} from "./thinkingLevels";
import { parseThinkingLevelMap } from "./modelCapabilityMatch";

/** A small structural boundary so the cache can be tested without spawning Pi. */
export type PiCapabilityRpcClient = {
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>;
};

/** The temporary no-session Pi process owned only while a hydration is active. */
export type PiCapabilityProcess = {
  start(
    sessionPath?: string,
    trustOverride?: "approve" | "no-approve",
    noSession?: boolean,
  ): Promise<PiCapabilityRpcClient>;
  stop(): void;
};

export type PiModelCapabilitySnapshot = {
  generation: number;
  createdAt: number;
  models: AvailableModel[];
};

export type PiModelCapabilityCacheDeps = {
  createProcess: () => PiCapabilityProcess;
  getConfigDirectory?: () => string;
  watchDirectory?: (
    directory: string,
    listener: (eventType: string, fileName: string | Buffer | null) => void,
  ) => Pick<FSWatcher, "close">;
  onWarning?: (message: string, detail: Record<string, string | number | boolean | null>) => void;
  now?: () => number;
  debounceMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function cloneModel(model: AvailableModel): AvailableModel {
  return {
    ...model,
    ...(model.input ? { input: [...model.input] } : {}),
    ...(model.thinkingLevels ? { thinkingLevels: [...model.thinkingLevels] } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
  };
}

function cloneSnapshot(snapshot: PiModelCapabilitySnapshot): PiModelCapabilitySnapshot {
  return {
    ...snapshot,
    models: snapshot.models.map(cloneModel),
  };
}

function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}

function toAvailableModel(value: unknown): AvailableModel | undefined {
  if (!isRecord(value)) return undefined;
  const provider = nonEmptyString(value.provider);
  const id = nonEmptyString(value.id);
  if (!provider || !id) return undefined;

  const model: AvailableModel = { provider, id };
  const name = nonEmptyString(value.name);
  const contextWindow = positiveInteger(value.contextWindow);
  const maxTokens = positiveInteger(value.maxTokens);
  if (name) model.name = name;
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  if (typeof value.reasoning === "boolean") model.reasoning = value.reasoning;
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : undefined;
  const thinkingLevelMap = parseThinkingLevelMap(value.thinkingLevelMap);
  if (input && input.length > 0) {
    model.input = input;
    model.images = input.includes("image");
  }
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  return model;
}

/** Parse the full Pi RPC model snapshot without trusting untyped subprocess data. */
export function parseAvailableModelsResponse(response: {
  success: boolean;
  data?: unknown;
  error?: string;
}): AvailableModel[] {
  if (!response.success) {
    throw new Error(response.error?.trim() || "get_available_models failed");
  }
  if (!isRecord(response.data) || !Array.isArray(response.data.models)) {
    throw new Error("get_available_models returned malformed data");
  }

  const unique = new Map<string, AvailableModel>();
  for (const rawModel of response.data.models) {
    const model = toAvailableModel(rawModel);
    if (!model) continue;
    const key = modelKey(model.provider, model.id);
    if (!unique.has(key)) unique.set(key, model);
  }
  return [...unique.values()];
}

function isRelevantConfigFile(fileName: string | Buffer | null): boolean {
  const normalized = typeof fileName === "string"
    ? fileName
    : Buffer.isBuffer(fileName)
      ? fileName.toString("utf8")
      : "";
  return normalized === "models.json" || normalized === "auth.json";
}

/**
 * Builds one in-memory, Pi-authoritative model capability snapshot per config
 * generation. It never sends a prompt and tears down its process after hydration.
 */
export class PiModelCapabilityCache {
  private generation = 0;
  private snapshot: PiModelCapabilitySnapshot | null = null;
  private failedGeneration: number | null = null;
  private inFlight: { generation: number; promise: Promise<PiModelCapabilitySnapshot | null> } | null = null;
  private activeProcess: PiCapabilityProcess | null = null;
  private watcher: Pick<FSWatcher, "close"> | null = null;
  private watcherTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: PiModelCapabilityCacheDeps) {}

  getSnapshot(): PiModelCapabilitySnapshot | null {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  /** Reuse an already published or active hydration instead of spawning per picker. */
  ensure(): Promise<PiModelCapabilitySnapshot | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.snapshot) return Promise.resolve(cloneSnapshot(this.snapshot));
    if (this.failedGeneration === this.generation) return Promise.resolve(null);
    if (this.inFlight?.generation === this.generation) return this.inFlight.promise;
    return this.startRefresh(this.generation);
  }

  /** Explicit refresh creates a new generation so late old probe results are discarded. */
  refresh(): Promise<PiModelCapabilitySnapshot | null> {
    if (this.disposed) return Promise.resolve(null);
    const generation = this.invalidateInternal();
    return this.startRefresh(generation);
  }

  /** Clear exact results without forcing an immediate spawn. */
  invalidate(): void {
    if (this.disposed) return;
    this.invalidateInternal();
  }

  /** Watch only Pi files that can alter the globally available model set. */
  watchConfigDirectory(): void {
    this.closeWatcher();
    const directory = this.deps.getConfigDirectory?.();
    if (!directory || !this.deps.watchDirectory || this.disposed) return;
    try {
      this.watcher = this.deps.watchDirectory(directory, (_eventType, fileName) => {
        if (!isRelevantConfigFile(fileName)) return;
        this.scheduleWatcherRefresh();
      });
    } catch (error) {
      this.warn("Pi capability config watcher could not start", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.snapshot = null;
    this.failedGeneration = null;
    this.activeProcess?.stop();
    this.activeProcess = null;
    this.closeWatcher();
  }

  private invalidateInternal(): number {
    this.generation += 1;
    this.snapshot = null;
    this.failedGeneration = null;
    this.activeProcess?.stop();
    this.activeProcess = null;
    return this.generation;
  }

  private startRefresh(generation: number): Promise<PiModelCapabilitySnapshot | null> {
    const task = this.hydrate(generation)
      .catch((error) => {
        if (!this.disposed && generation === this.generation) {
          this.failedGeneration = generation;
          this.warn("Pi capability hydration failed", {
            generation,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      });
    this.inFlight = { generation, promise: task };
    void task.finally(() => {
      if (this.inFlight?.promise === task) this.inFlight = null;
    });
    return task;
  }

  private async hydrate(generation: number): Promise<PiModelCapabilitySnapshot | null> {
    const process = this.deps.createProcess();
    this.activeProcess = process;
    try {
      const client = await process.start(undefined, undefined, true);
      const response = await client.request(
        { type: "get_available_models" },
        this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      const models = parseAvailableModelsResponse(response);
      const hydrated: AvailableModel[] = [];
      for (const model of models) {
        if (this.disposed || generation !== this.generation) return null;
        const levels = await this.queryModelThinkingLevels(client, model);
        hydrated.push(levels === undefined ? model : { ...model, thinkingLevels: levels });
      }

      if (this.disposed || generation !== this.generation) return null;
      const snapshot: PiModelCapabilitySnapshot = {
        generation,
        createdAt: (this.deps.now ?? Date.now)(),
        models: hydrated,
      };
      this.snapshot = snapshot;
      this.failedGeneration = null;
      return cloneSnapshot(snapshot);
    } finally {
      // A newer generation has already stopped and replaced this probe. Only the
      // current owner may stop it here, otherwise refresh races double-kill it.
      if (this.activeProcess === process) {
        process.stop();
        this.activeProcess = null;
      }
    }
  }

  private async queryModelThinkingLevels(
    client: PiCapabilityRpcClient,
    model: AvailableModel,
  ): Promise<string[] | undefined> {
    const timeoutMs = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const setModelResponse = await client.request(
      { type: "set_model", provider: model.provider, modelId: model.id },
      timeoutMs,
    );
    // A model may disappear while config/auth changes. Keep the model list entry,
    // but do not label its previous capability as authoritative.
    if (!setModelResponse.success) return undefined;

    const levelsResponse = await client.request(
      { type: "get_available_thinking_levels" },
      timeoutMs,
    );
    if (!levelsResponse.success && isUnsupportedThinkingLevelsRpcError(levelsResponse.error ?? "")) {
      throw new Error(levelsResponse.error ?? "get_available_thinking_levels is unavailable");
    }
    try {
      return parseAvailableThinkingLevelsResponse(levelsResponse);
    } catch {
      return undefined;
    }
  }

  private scheduleWatcherRefresh(): void {
    if (this.watcherTimer) clearTimeout(this.watcherTimer);
    this.watcherTimer = setTimeout(() => {
      this.watcherTimer = null;
      void this.refresh();
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private closeWatcher(): void {
    if (this.watcherTimer) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private warn(message: string, detail: Record<string, string | number | boolean | null>): void {
    this.deps.onWarning?.(message, detail);
  }
}

/** Default Node watcher adapter, kept exported so tests can substitute a deterministic fake. */
export function watchPiConfigDirectory(
  directory: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
): Pick<FSWatcher, "close"> {
  return watch(directory, { persistent: false }, listener);
}
