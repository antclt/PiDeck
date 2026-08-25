import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  isUnsupportedThinkingLevelsRpcError,
  parseAvailableThinkingLevelsResponse,
} = loadTsCommonJs("src/main/pi/thinkingLevels.ts");
const { toThinkingPickerLevels } = loadTsCommonJs(
  "src/renderer/src/components/session/sessionPickerOptions.ts",
);

const { readFile } = await import("node:fs/promises");
const [pickerSource, ipcSource, sessionIpcSource, preloadSource] = await Promise.all([
  readFile("src/renderer/src/components/session/ComposerPickerHost.tsx", "utf8"),
  readFile("src/shared/ipc.ts", "utf8"),
  readFile("src/main/ipc/sessionIpc.ts", "utf8"),
  readFile("src/preload/index.ts", "utf8"),
]);

test("Pi thinking RPC parses and de-duplicates authoritative levels", () => {
  assert.deepEqual(
    Array.from(parseAvailableThinkingLevelsResponse({
      success: true,
      data: { levels: ["off", " high ", "high", "max"] },
    })),
    ["off", "high", "max"],
  );
});

test("Pi thinking RPC preserves an authoritative empty list", () => {
  assert.deepEqual(
    Array.from(parseAvailableThinkingLevelsResponse({ success: true, data: { levels: [] } })),
    [],
  );
});

test("thinking level ids keep localized known labels and tolerate future ids", () => {
  const levels = toThinkingPickerLevels(["off", "future-level", "off"]);
  assert.equal(levels.length, 2);
  assert.equal(levels[0].labelKey, "thinking.levelLabel.off");
  assert.equal(levels[1].value, "future-level");
  assert.equal(levels[1].label, "future-level");
});

test("malformed success data falls back instead of hiding the picker", () => {
  assert.equal(
    parseAvailableThinkingLevelsResponse({ success: true, data: { levels: ["off", 3] } }),
    undefined,
  );
  assert.equal(
    parseAvailableThinkingLevelsResponse({ success: true, data: {} }),
    undefined,
  );
});

test("unknown RPC from an older Pi is a compatibility fallback", () => {
  assert.equal(
    isUnsupportedThinkingLevelsRpcError("Unknown command: get_available_thinking_levels"),
    true,
  );
  assert.equal(
    parseAvailableThinkingLevelsResponse({
      success: false,
      error: "Unknown command: get_available_thinking_levels",
    }),
    undefined,
  );
});

test("non-compatibility RPC errors are not swallowed", () => {
  assert.throws(
    () => parseAvailableThinkingLevelsResponse({ success: false, error: "agent is busy" }),
    /agent is busy/,
  );
});

test("Pi picker preloads and caches runtime-specific levels by runtime identity", () => {
  assert.match(pickerSource, /beginPiRuntimeThinkingLevels\(\{ sessionId, target \}\)/);
  assert.match(pickerSource, /desktopApi\.sessions\.listRuntimeThinkingLevels\(\{/);
  assert.match(pickerSource, /resolvePiRuntimeThinkingLevels\(\{/);
  assert.match(pickerSource, /toThinkingPickerLevels\(runtimeLevels\)/);
  assert.doesNotMatch(pickerSource, /props\.picker !== "thinking"/);
});

test("thinking-level RPC is wired through shared IPC, main handler, and preload", () => {
  assert.match(ipcSource, /sessionsRuntimeThinkingLevels: "sessions:runtime-thinking-levels"/);
  assert.match(sessionIpcSource, /ipcChannels\.sessionsRuntimeThinkingLevels/);
  assert.match(preloadSource, /listRuntimeThinkingLevels: /);
});
