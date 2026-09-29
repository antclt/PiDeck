/**
 * CUA Approval Gate — Plan A (in-process).
 *
 * The CUA MCP server runs INSIDE the PiDeck Electron main process and is
 * served over Streamable HTTP (see CuaMcpHttpHost). Because it shares the main
 * process, approval does NOT need a loopback HTTP hop: the gate calls an
 * in-process handler that pushes the request to the renderer via IPC
 * (CuaIpcManager) and waits for the user's decision.
 *
 * Flow:
 *   CUA tool (write) → CuaEngine → CuaGate.check()
 *     → approvalHandler (CuaIpcManager.createApprovalHandler)
 *     → IPC cua:approval-request → 渲染层审批对话框
 *     → IPC cua:approval-response → resolved
 *
 * Safety default: if no approval handler is wired, write actions are DENIED
 * (fail closed). Read-only actions never reach the gate.
 */

export type CuaActionType = "click" | "type" | "scroll" | "capture" | "list_windows" | "get_state";

export type CuaGateDecision = {
  allowed: boolean;
  reason?: string;
};

/** Request passed to the approval handler / renderer dialog. */
export type CuaApprovalRequest = {
  action: CuaActionType;
  sessionId: string;
  detail: unknown;
  timestampMs: number;
};

/** Result returned from the approval handler. */
export type CuaApprovalResponse = {
  allowed: boolean;
  reason?: string;
};

export type CuaGateConfig = {
  /** Global kill switch. */
  enabled: boolean;
  /** Session-level kill switches. Keyed by sessionId. */
  sessionOverrides: Map<string, boolean>;
  /** Approval timeout in milliseconds. */
  approvalTimeoutMs: number;
  /**
   * In-process approval handler. When null, write actions are denied
   * (fail closed).
   */
  approvalHandler: ((request: CuaApprovalRequest) => Promise<CuaApprovalResponse>) | null;
};

const READONLY_ACTIONS: ReadonlySet<CuaActionType> = new Set(["capture", "list_windows", "get_state"]);

export class CuaGate {
  private config: CuaGateConfig;

  constructor(config?: Partial<CuaGateConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      sessionOverrides: config?.sessionOverrides ?? new Map(),
      approvalTimeoutMs: config?.approvalTimeoutMs ?? 30000,
      approvalHandler: config?.approvalHandler ?? null,
    };
  }

  /**
   * Set (or clear) the in-process approval handler. Used by the main process to
   * wire the gate directly to the renderer approval dialog.
   */
  setApprovalHandler(handler: ((request: CuaApprovalRequest) => Promise<CuaApprovalResponse>) | null): void {
    this.config.approvalHandler = handler;
  }

  /**
   * Check whether an action is permitted for a given session.
   */
  async check(action: CuaActionType, sessionId: string, detail: unknown): Promise<CuaGateDecision> {
    // Read-only actions always pass.
    if (READONLY_ACTIONS.has(action)) {
      return { allowed: true };
    }

    // Global kill switch.
    if (!this.config.enabled) {
      return { allowed: false, reason: "cua_disabled" };
    }

    // Session-level override.
    const sessionEnabled = this.config.sessionOverrides.get(sessionId);
    if (sessionEnabled === false) {
      return { allowed: false, reason: "cua_disabled" };
    }

    // No handler wired → fail closed.
    const handler = this.config.approvalHandler;
    if (!handler) {
      return { allowed: false, reason: "no_approval_handler" };
    }

    const requestBody: CuaApprovalRequest = {
      action,
      sessionId,
      detail,
      timestampMs: Date.now(),
    };

    // Guard against a handler that never settles.
    try {
      const result = await this.withTimeout(handler(requestBody), this.config.approvalTimeoutMs);
      return { allowed: result.allowed, reason: result.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { allowed: false, reason: `approval_request_failed: ${message}` };
    }
  }

  /**
   * Update the global kill switch.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Set a session-level override.
   */
  setSessionOverride(sessionId: string, enabled: boolean | null): void {
    if (enabled === null) {
      this.config.sessionOverrides.delete(sessionId);
    } else {
      this.config.sessionOverrides.set(sessionId, enabled);
    }
  }

  /**
   * Whether the gate is globally enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Whether a specific session has CUA enabled.
   */
  isSessionEnabled(sessionId: string): boolean {
    const override = this.config.sessionOverrides.get(sessionId);
    return override ?? this.config.enabled;
  }

  /** Snapshot of the session overrides (for IPC state reporting). */
  getSessionOverrides(): Record<string, boolean> {
    return Object.fromEntries(this.config.sessionOverrides);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("approval_timeout")), ms);
      promise.then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }
}
