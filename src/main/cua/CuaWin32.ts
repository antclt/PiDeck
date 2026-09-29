import koffi from "koffi";

/**
 * Low-level Win32 bindings for CUA (Computer Use Agent).
 *
 * This module only declares the exact functions and constants needed for
 * screen capture metadata, window enumeration, Z-order analysis, and
 * SendInput-based mouse/keyboard injection.
 *
 * koffi caveats observed during probe1-probe5:
 * - Use `void *` for HWND, `uint32_t` for DWORD, and explicitly declared
 *   structs for RECT/POINT/INPUT.
 * - `_Out_` annotations are required on pointer output parameters, otherwise
 *   koffi does not write results back into the JS object.
 * - Struct declarations must precede function declarations that reference them.
 */

export const user32 = koffi.load("user32.dll");
export const kernel32 = koffi.load("kernel32.dll");

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

export const POINT = koffi.struct("POINT", {
  x: "long",
  y: "long",
});

export const RECT = koffi.struct("RECT", {
  left: "long",
  top: "long",
  right: "long",
  bottom: "long",
});

/**
 * INPUT struct layout used by SendInput.
 * Union of mouse/keyboard/hardware. We only use the keyboard branch for
 * virtual-key input and the mouse branch for absolute coordinate injection.
 * Total size must be 40 bytes on 64-bit Windows.
 */
export const INPUT = koffi.struct("INPUT", {
  type: "uint32_t",
  // Anonymous union represented as padding + overlapping fields.
  // Layout matches Windows' INPUT (after 4-byte type):
  //   mi: MOUSEINPUT (28 bytes) | ki: KEYBDINPUT (16 bytes) | hi: HARDWAREINPUT (8 bytes)
  // We include all fields sequentially because koffi does not support unions.
  mi_dx: "long",
  mi_dy: "long",
  mi_mouseData: "uint32_t",
  mi_dwFlags: "uint32_t",
  mi_time: "uint32_t",
  mi_dwExtraInfo: "uintptr_t",
  ki_wVk: "uint16_t",
  ki_wScan: "uint16_t",
  ki_dwFlags: "uint32_t",
  ki_time: "uint32_t",
  ki_dwExtraInfo: "uintptr_t",
  hi_uMsg: "uint32_t",
  hi_wParamL: "uint16_t",
  hi_wParamH: "uint16_t",
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF_MOVE = 0x0001;
export const MOUSEEVENTF_LEFTDOWN = 0x0002;
export const MOUSEEVENTF_LEFTUP = 0x0004;
export const MOUSEEVENTF_RIGHTDOWN = 0x0008;
export const MOUSEEVENTF_RIGHTUP = 0x0010;
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
export const MOUSEEVENTF_MIDDLEUP = 0x0040;
export const MOUSEEVENTF_ABSOLUTE = 0x8000;
export const MOUSEEVENTF_VIRTUALDESK = 0x4000;

export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_SCANCODE = 0x0008;
export const KEYEVENTF_UNICODE = 0x0004;

export const SW_SHOWNORMAL = 1;
export const SW_SHOWMINIMIZED = 2;
export const SW_SHOWMAXIMIZED = 3;
export const SW_RESTORE = 9;

export const HWND_TOPMOST = -1;
export const HWND_NOTOPMOST = -2;

export const SWP_FRAMECHANGED = 0x0020;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOSIZE = 0x0001;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SHOWWINDOW = 0x0040;

// ---------------------------------------------------------------------------
// Function bindings
// ---------------------------------------------------------------------------

export const GetSystemMetrics = user32.func("int GetSystemMetrics(int nIndex)");
export const GetCursorPos = user32.func("bool GetCursorPos(_Out_ POINT *p)");
export const SetCursorPos = user32.func("bool SetCursorPos(int x, int y)");

export const SendInput = user32.func("uint32_t SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)");

export const GetForegroundWindow = user32.func("void *GetForegroundWindow()");
export const SetForegroundWindow = user32.func("bool SetForegroundWindow(void *hWnd)");
export const ShowWindow = user32.func("bool ShowWindow(void *hWnd, int nCmdShow)");
export const ShowWindowAsync = user32.func("bool ShowWindowAsync(void *hWnd, int nCmdShow)");
export const SetWindowPos = user32.func("bool SetWindowPos(void *hWnd, void *hWndInsertAfter, int x, int y, int cx, int cy, uint32_t uFlags)");
export const IsWindow = user32.func("bool IsWindow(void *hWnd)");
export const IsWindowVisible = user32.func("bool IsWindowVisible(void *hWnd)");
export const GetWindowRect = user32.func("bool GetWindowRect(void *hWnd, _Out_ RECT *p)");
export const GetWindowTextLengthW = user32.func("int GetWindowTextLengthW(void *hWnd)");
export const GetWindowTextW = user32.func("int GetWindowTextW(void *hWnd, _Out_ wchar_t *lpString, int nMaxCount)");
export const GetWindowThreadProcessId = user32.func("uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *p)");

export const GetCurrentThreadId = kernel32.func("uint32_t GetCurrentThreadId()");

// EnumWindows callback prototype: return false to stop enumeration.
const EnumWindowsProc = koffi.proto("bool EnumWindowsProc(void *hWnd, intptr_t lParam)");
export const EnumWindows = user32.func("bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type WindowInfo = {
  hwnd: number;
  title: string;
  pid: number;
  rect: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  isForeground: boolean;
  isTopmost: boolean;
  zIndex: number;
};

/**
 * Enumerate visible top-level windows in Z-order (front to back).
 */
export function enumerateWindows(): WindowInfo[] {
  const windows: WindowInfo[] = [];
  const fg = GetForegroundWindow();

  EnumWindows((hwndPtr: unknown, _lParam: number) => {
    if (!hwndPtr) return true;
    const hwnd = Number(koffi.address(hwndPtr));

    if (!IsWindowVisible(hwndPtr)) return true;

    const rect: { left: number; top: number; right: number; bottom: number } = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetWindowRect(hwndPtr, rect)) return true;

    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) return true;

    const pidBuf = [0] as [number];
    GetWindowThreadProcessId(hwndPtr, pidBuf);
    const pid = pidBuf[0];

    const titleLength = GetWindowTextLengthW(hwndPtr);
    let title = "";
    if (titleLength > 0) {
      // wchar_t buffer; each char is 2 bytes.
      const buffer = Buffer.alloc((titleLength + 1) * 2);
      GetWindowTextW(hwndPtr, buffer, titleLength + 1);
      title = buffer.toString("utf16le").replace(/\0/g, "");
    }

    const exStyle = GetWindowLongPtrW(hwndPtr, GWL_EXSTYLE);
    const isTopmost = (exStyle & WS_EX_TOPMOST) !== 0;

    windows.push({
      hwnd,
      title,
      pid,
      rect: { x: rect.left, y: rect.top, width, height },
      isVisible: true,
      isForeground: hwnd === Number(koffi.address(fg)),
      isTopmost,
      zIndex: windows.length,
    });

    return true;
  }, 0n);

  return windows;
}

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;

// GetWindowLongPtrW binding for 64-bit (returns LONG_PTR).
export const GetWindowLongPtrW = user32.func("intptr_t GetWindowLongPtrW(void *hWnd, int nIndex)");

/**
 * Convert a screen pixel coordinate to the normalized 0..65535 range required
 * by SendInput with MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK.
 */
export function normalizeAbsoluteCoordinate(x: number, y: number, screenWidth: number, screenHeight: number): { x: number; y: number } {
  if (screenWidth <= 0 || screenHeight <= 0) {
    throw new Error("Invalid screen dimensions");
  }
  // Windows maps 0..65535 across the virtual desktop.
  const nx = Math.round((x * 65535) / (screenWidth - 1));
  const ny = Math.round((y * 65535) / (screenHeight - 1));
  return { x: clamp(nx, 0, 65535), y: clamp(ny, 0, 65535) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Build a mouse INPUT struct for SendInput absolute coordinate injection.
 */
export function buildMouseInput(x: number, y: number, flags: number): Record<string, number> {
  return {
    type: INPUT_MOUSE,
    mi_dx: x,
    mi_dy: y,
    mi_mouseData: 0,
    mi_dwFlags: flags,
    mi_time: 0,
    mi_dwExtraInfo: 0,
    ki_wVk: 0,
    ki_wScan: 0,
    ki_dwFlags: 0,
    ki_time: 0,
    ki_dwExtraInfo: 0,
    hi_uMsg: 0,
    hi_wParamL: 0,
    hi_wParamH: 0,
  };
}

/**
 * Build a keyboard INPUT struct for SendInput.
 */
export function buildKeyboardInput(vk: number, scan: number, flags: number): Record<string, number> {
  return {
    type: INPUT_KEYBOARD,
    mi_dx: 0,
    mi_dy: 0,
    mi_mouseData: 0,
    mi_dwFlags: 0,
    mi_time: 0,
    mi_dwExtraInfo: 0,
    ki_wVk: vk,
    ki_wScan: scan,
    ki_dwFlags: flags,
    ki_time: 0,
    ki_dwExtraInfo: 0,
    hi_uMsg: 0,
    hi_wParamL: 0,
    hi_wParamH: 0,
  };
}

/**
 * Send a sequence of INPUT structs via SendInput.
 */
export function sendInputs(inputs: Record<string, number>[]): number {
  if (inputs.length === 0) return 0;
  // koffi 3.x: pass the JS array directly for call-by-reference arrays.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return SendInput(inputs.length, inputs as any, koffi.sizeof(INPUT));
}

/**
 * Convenience: move the cursor to an absolute screen pixel coordinate.
 */
export function moveMouseAbsolute(x: number, y: number, screenWidth: number, screenHeight: number): number {
  const norm = normalizeAbsoluteCoordinate(x, y, screenWidth, screenHeight);
  return sendInputs([buildMouseInput(norm.x, norm.y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)]);
}

/**
 * Convenience: click at an absolute screen pixel coordinate.
 */
export function clickAt(x: number, y: number, button: "left" | "right" | "middle", screenWidth: number, screenHeight: number): number {
  const norm = normalizeAbsoluteCoordinate(x, y, screenWidth, screenHeight);
  const flagsDown =
    button === "left"
      ? MOUSEEVENTF_LEFTDOWN
      : button === "right"
        ? MOUSEEVENTF_RIGHTDOWN
        : MOUSEEVENTF_MIDDLEDOWN;
  const flagsUp =
    button === "left"
      ? MOUSEEVENTF_LEFTUP
      : button === "right"
        ? MOUSEEVENTF_RIGHTUP
        : MOUSEEVENTF_MIDDLEUP;
  return sendInputs([
    buildMouseInput(norm.x, norm.y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
    buildMouseInput(0, 0, flagsDown),
    buildMouseInput(0, 0, flagsUp),
  ]);
}

// ---------------------------------------------------------------------------
// Keyboard helpers
// ---------------------------------------------------------------------------

/** Common virtual-key codes. */
export const VK_MAP: Record<string, number> = {
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  space: 0x20,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  win: 0x5b,
};

/** Modifier virtual-key codes in order. */
const MODIFIER_KEYS = [0x11, 0x12, 0x10, 0x5b]; // ctrl, alt, shift, win

/**
 * Press a key combination (e.g. Ctrl+C).
 * @param vk Virtual-key code of the main key.
 * @param modifiers Array of modifier vk codes.
 */
export function pressKeyCombo(vk: number, modifiers: number[] = []): number {
  const inputs: Record<string, number>[] = [];
  // Press modifiers down.
  for (const mod of modifiers) {
    inputs.push(buildKeyboardInput(mod, 0, 0));
  }
  // Press main key down + up.
  inputs.push(buildKeyboardInput(vk, 0, 0));
  inputs.push(buildKeyboardInput(vk, 0, KEYEVENTF_KEYUP));
  // Release modifiers in reverse order.
  for (let i = modifiers.length - 1; i >= 0; i--) {
    inputs.push(buildKeyboardInput(modifiers[i], 0, KEYEVENTF_KEYUP));
  }
  return sendInputs(inputs);
}

/**
 * Type a Unicode string character by character using SendInput.
 * Uses KEYEVENTF_UNICODE for full Unicode support.
 */
export function typeUnicode(text: string): number {
  const inputs: Record<string, number>[] = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // down
    inputs.push(buildKeyboardInput(0, code, KEYEVENTF_UNICODE));
    // up
    inputs.push(buildKeyboardInput(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
  }
  return sendInputs(inputs);
}

// ---------------------------------------------------------------------------
// Scroll helper
// ---------------------------------------------------------------------------

export const MOUSEEVENTF_WHEEL = 0x0800;
export const MOUSEEVENTF_HWHEEL = 0x1000;

/**
 * Scroll the mouse wheel at an absolute screen coordinate.
 * @param deltaY Positive = scroll down, negative = scroll up (Windows convention).
 */
export function scrollAt(
  x: number,
  y: number,
  deltaY: number,
  deltaX: number,
  screenWidth: number,
  screenHeight: number,
): number {
  const norm = normalizeAbsoluteCoordinate(x, y, screenWidth, screenHeight);
  const inputs: Record<string, number>[] = [
    buildMouseInput(norm.x, norm.y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK),
  ];
  if (deltaY !== 0) {
    const wheelInput = buildMouseInput(0, 0, MOUSEEVENTF_WHEEL);
    wheelInput.mi_mouseData = deltaY;
    inputs.push(wheelInput);
  }
  if (deltaX !== 0) {
    const hwheelInput = buildMouseInput(0, 0, MOUSEEVENTF_HWHEEL);
    hwheelInput.mi_mouseData = deltaX;
    inputs.push(hwheelInput);
  }
  return sendInputs(inputs);
}
