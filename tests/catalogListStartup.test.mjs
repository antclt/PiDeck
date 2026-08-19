import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
const projectSync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");

test("first catalog list returns disk cache instead of awaiting a full scan", () => {
  // 打包正式 userData 里历史 JSONL 远多于 dev。首次 listCatalog 若 await
  // runScanAndMerge()，侧栏「正在加载历史会话」会卡住整窗（主进程扫盘 + 大 IPC）。
  const handler = sessionIpc.slice(
    sessionIpc.indexOf("ipcChannels.sessionsCatalogList"),
    sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"),
  );
  assert.match(handler, /if \(options\?\.scan === false\) return cachedRecords;/);
  // 有磁盘 catalog 或空列表都先回缓存，扫描只走 coordinator 后台。
  assert.doesNotMatch(handler, /if \(!scannedProjects\.has\(projectId\)\) \{[\s\S]*return runScanAndMerge\(\);/);
  assert.match(handler, /catalogScanCoordinator\.schedule\(projectId,/);
  assert.match(handler, /return cachedRecords;/);
});

test("catalog list scan does not parse JSONL bodies", () => {
  // 侧栏 list() 只 stat + 路径推断；正文留给点击后的 readRecordMessagePage。
  const listBlock = scanner.slice(
    scanner.indexOf("private async listUnqueued"),
    scanner.indexOf("private async resolveScanRoots"),
  );
  assert.match(listBlock, /listPathSummary/);
  assert.doesNotMatch(listBlock, /this\.readSummary\(/);
  assert.doesNotMatch(listBlock, /isParentSessionForProject/);
  assert.match(scanner, /listQueue/);
  assert.match(scanner, /mapLimited/);
  assert.match(scanner, /SUMMARY_READ_CONCURRENCY = 4/);
});

test("startup catalog refresh keeps the loading spinner until a scan fills an empty cache", () => {
  // 空缓存立即回 [] 时不能立刻 set ready，否则加载动画闪一下后侧栏空白很久。
  assert.match(projectSync, /if \(records\.length > 0\) \{[\s\S]*status: "ready"/);
  assert.match(projectSync, /onCatalogRefreshed/);
});
