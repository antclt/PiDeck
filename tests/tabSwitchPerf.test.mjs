import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const historyReaderSource = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
const fileServiceSource = readFileSync("src/main/fs/FileSystemService.ts", "utf8");
const filesIpcSource = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
const composerSource = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);

test("tab switch does not refresh the project file tree or git branches", () => {
  // 切会话只改 currentSessionId / displayAgents.length；把它们绑进 files.list
  // 会让空白新 tab 也整棵扫盘 + 巨大 IPC，两边切都会假死。
  const effectStart = appSource.indexOf("setExpandedDirs(new Set());\n    void api.files");
  assert.equal(
    effectStart,
    -1,
    "files.list effect must not clear expandedDirs (that belongs to project switch only)",
  );
  assert.match(appSource, /api\.files\.list\(activeProjectId, \{ maxDepth: 0 \}\)/);
  assert.match(
    appSource,
    /api\.git\s*\.branches\(activeProjectId\)[\s\S]{0,280}\}, \[activeProjectId, loadExpandedDirs\]/,
  );
  assert.doesNotMatch(
    appSource,
    /api\.git\s*\.branches\(activeProjectId\)[\s\S]{0,200}\}, \[activeProjectId, currentSessionId, displayAgents\.length\]/,
  );
});

test("solo ChatSessionPane is reused across tab switches", () => {
  // 分屏栏仍按 sessionId 挂独立实例；单栏禁止 key=currentSessionId 整栏销毁。
  const soloBlock = appSource.slice(
    appSource.indexOf("solo={"),
    appSource.indexOf("soloSessionId="),
  );
  assert.match(soloBlock, /<ChatSessionPane/);
  assert.doesNotMatch(soloBlock, /key=\{currentSessionId\}/);
  assert.match(appSource, /renderSession=\{\(sessionId\) => \(\s*<ChatSessionPane\s+key=\{sessionId\}/);
});

test("file tree list is shallow by default in the drawer and accepts a scoped directory", () => {
  assert.match(fileServiceSource, /hasChildren/);
  assert.match(filesIpcSource, /maxDepth/);
  assert.match(filesIpcSource, /directory/);
  assert.match(appSource, /maxDepth:\s*0/);
  // composer @ 引用仍要一棵有限深度的树，但只跟 projectId，不跟 sessionId
  assert.match(composerSource, /maxDepth:\s*8/);
  assert.match(composerSource, /desktopApi\.files\.list\(record\.projectId, \{ maxDepth: 8 \}\)/);
  assert.match(composerSource, /\}, \[record\?\.projectId\]\);/);
});

test("session display index yields during a full rebuild", () => {
  assert.match(historyReaderSource, /INDEX_PARSE_YIELD_EVERY/);
  assert.match(historyReaderSource, /setImmediate/);
  assert.match(historyReaderSource, /getSessionDisplayIndex/);
});
