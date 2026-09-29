import koffi from "koffi";
import {
  clickAt,
  GetForegroundWindow,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  IsWindow,
  moveMouseAbsolute,
  pressKeyCombo,
  scrollAt,
  SetWindowPos,
  ShowWindow,
  SW_RESTORE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
  typeUnicode,
  VK_MAP,
  type WindowInfo,
} from "./CuaWin32";
import { analyzeWindows, findWindowByTitle, getPrimaryDisplay, type OcclusionInfo } from "./CuaWindowAnalyzer";
import { CuaGate, type CuaActionType } from "./CuaGate";

/**
 * High-level CUA engine: window activation, input injection, and state queries.
 *
 * Activation strategy (validated by probe5):
 * 1. Find the target window and its visible title-bar point.
 * 2. Temporarily make it TOPMOST so it can receive input even if not foreground.
 * 3. Click a visible point on its title bar to bring it to the foreground.
 * 4. Remove the TOPMOST flag so we do not permanently alter the user's window stack.
 *
 * This works around Windows' foreground-lock restrictions where
 * SetForegroundWindow fails across processes.
 */

export type CuaActionOptions = {
  /** If provided, try to activate the matching window before acting. */
  activateTarget?: string;
  /** If true, require that the action coordinate is not fully occluded. */
  requireVisible?: boolean;
};

export type CuaEngineConfig = {
  /** Default delay between window operations in milliseconds. */
  defaultDelayMs: number;
};

export type CuaActionResult = {
  sent: number;
  error?: string;
  gateDecision?: string;
};

export class CuaEngine {
  private config: CuaEngineConfig;
  private gate: CuaGate;

  constructor(config: CuaEngineConfig = { defaultDelayMs: 80 }, gate?: CuaGate) {
    this.config = config;
    this.gate = gate ?? new CuaGate();
  }

  // -------------------------------------------------------------------------
  // Read-only operations (no gate check needed)
  // -------------------------------------------------------------------------

  listWindows(): OcclusionInfo[] {
    return analyzeWindows();
  }

  getDisplay(): { width: number; height: number } {
    return getPrimaryDisplay();
  }

  getForegroundWindow(): OcclusionInfo | undefined {
    const analyzed = analyzeWindows();
    return analyzed.find((info) => info.window.isForeground);
  }

  findWindow(titleSubstring: string): OcclusionInfo | undefined {
    return findWindowByTitle(titleSubstring);
  }

  isPointVisible(x: number, y: number): boolean {
    const analyzed = analyzeWindows();
    for (const info of analyzed) {
      const r = info.window.rect;
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Window activation
  // -------------------------------------------------------------------------

  activateWindow(titleSubstring: string): { success: boolean; window?: WindowInfo; method: string; error?: string } {
    const info = findWindowByTitle(titleSubstring);
    if (!info) {
      return { success: false, method: "none", error: `Window not found: ${titleSubstring}` };
    }

    const hwnd = info.window.hwnd as unknown as object;
    if (!IsWindow(hwnd)) {
      return { success: false, method: "none", error: "Window handle is no longer valid" };
    }

    if (info.window.isForeground) {
      return { success: true, window: info.window, method: "already-foreground" };
    }

    ShowWindow(hwnd, SW_RESTORE);
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);

    const titleBarPoint = info.titleBarPoint;
    if (!titleBarPoint) {
      SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      return { success: false, method: "none", error: "Target window is fully occluded; no safe title-bar point" };
    }

    const display = getPrimaryDisplay();
    clickAt(titleBarPoint.x, titleBarPoint.y, "left", display.width, display.height);
    this.sleep(this.config.defaultDelayMs);
    SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);

    const nowForeground = this.hwndValue(GetForegroundWindow()) === info.window.hwnd;

    return {
      success: nowForeground,
      window: info.window,
      method: "topmost-click",
      error: nowForeground ? undefined : "Window did not become foreground after click",
    };
  }

  // -------------------------------------------------------------------------
  // Write operations (gate-checked)
  // -------------------------------------------------------------------------

  async click(
    sessionId: string,
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
    options: CuaActionOptions = {},
  ): Promise<CuaActionResult> {
    const decision = await this.gate.check("click" as CuaActionType, sessionId, { x, y, button });
    if (!decision.allowed) {
      return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
    }

    if (options.activateTarget) {
      const activation = this.activateWindow(options.activateTarget);
      if (!activation.success) {
        return { sent: 0, error: activation.error };
      }
    }

    const display = getPrimaryDisplay();

    if (options.requireVisible) {
      const visible = this.isPointVisible(x, y);
      if (!visible) {
        return { sent: 0, error: `Target coordinate (${x},${y}) is occluded` };
      }
    }

    return { sent: clickAt(x, y, button, display.width, display.height), gateDecision: "allowed" };
  }

  async type(
    sessionId: string,
    params: { text?: string; key?: string; modifiers?: string[] },
  ): Promise<CuaActionResult> {
    const decision = await this.gate.check("type" as CuaActionType, sessionId, params);
    if (!decision.allowed) {
      return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
    }

    if (params.text !== undefined) {
      return { sent: typeUnicode(params.text), gateDecision: "allowed" };
    }

    if (params.key !== undefined) {
      const vk = VK_MAP[params.key.toLowerCase()];
      if (vk === undefined) {
        return { sent: 0, error: `Unknown key: ${params.key}` };
      }
      const modVks = (params.modifiers ?? []).map((m) => {
        const mvk = VK_MAP[m.toLowerCase()];
        if (mvk === undefined) throw new Error(`Unknown modifier: ${m}`);
        return mvk;
      });
      return { sent: pressKeyCombo(vk, modVks), gateDecision: "allowed" };
    }

    return { sent: 0, error: "Either text or key must be provided" };
  }

  async scroll(
    sessionId: string,
    x: number,
    y: number,
    deltaY: number = -120,
    deltaX: number = 0,
  ): Promise<CuaActionResult> {
    const decision = await this.gate.check("scroll" as CuaActionType, sessionId, { x, y, deltaY, deltaX });
    if (!decision.allowed) {
      return { sent: 0, error: decision.reason ?? "denied", gateDecision: "denied" };
    }

    const display = getPrimaryDisplay();
    return { sent: scrollAt(x, y, deltaY, deltaX, display.width, display.height), gateDecision: "allowed" };
  }

  // -------------------------------------------------------------------------
  // Mouse move (no gate — move is not destructive)
  // -------------------------------------------------------------------------

  moveMouse(x: number, y: number): number {
    const display = getPrimaryDisplay();
    return moveMouseAbsolute(x, y, display.width, display.height);
  }

  // -------------------------------------------------------------------------
  // Gate accessors
  // -------------------------------------------------------------------------

  getGate(): CuaGate {
    return this.gate;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private hwndValue(hwnd: object): number {
    return Number(koffi.address(hwnd));
  }

  private sleep(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // busy wait
    }
  }
}